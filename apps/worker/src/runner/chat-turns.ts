import { and, eq, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import { publicAttachment, type ChatMessageDTO } from "@wfos/shared";
import { publish } from "../lib/redis";
import { log } from "../lib/logger";

type MessageRow = typeof messages.$inferSelect;
type NewMessage = typeof messages.$inferInsert;
/** A transaction handle (db.transaction's callback argument). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Shown when a reply was left half-written (process died, job stalled); same shape as runChat's error replies. */
export const CHAT_INTERRUPTED_TEXT = "⚠️ Runner error: the reply stopped without finishing.";

/** A streaming reply older than this has no run behind it any more. */
export const CHAT_TURN_STALE_MS = 15 * 60_000;

export function chatMessageDto(m: MessageRow): ChatMessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    parentId: m.parentId,
    role: m.role,
    content: m.content,
    employeeId: m.employeeId,
    taskId: m.taskId,
    attachments: m.attachments.map(publicAttachment),
    status: m.status,
    meta: m.meta,
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * Close the still-streaming assistant rows matching `filter` as errors (keeping any text already
 * written) and publish each. Conditional on status 'streaming', so a reply that finished in the
 * meantime is never touched. Returns the closed rows.
 */
async function closeTurns(filter: SQL): Promise<MessageRow[]> {
  const rows = await db
    .update(messages)
    .set({ status: "error", content: sql`coalesce(nullif(${messages.content}, ''), ${CHAT_INTERRUPTED_TEXT})` })
    .where(and(eq(messages.role, "assistant"), eq(messages.status, "streaming"), filter))
    .returning();
  if (!rows.length) return rows;
  const convs = await db
    .select({ id: conversations.id, workspaceId: conversations.workspaceId })
    .from(conversations)
    .where(inArray(conversations.id, [...new Set(rows.map((m) => m.conversationId))]));
  for (const m of rows) {
    const ws = convs.find((c) => c.id === m.conversationId)?.workspaceId;
    if (!ws) continue;
    await publish(ws, { type: "chat.message", conversationId: m.conversationId, message: chatMessageDto(m) }).catch((e: unknown) =>
      log.warn({ err: e, messageId: m.id }, "chat: publishing the closed turn failed"),
    );
  }
  return rows;
}

/** The turn that folded in `userMessageId` (its assistant row lists it in meta.turnMessageIds), if still streaming. */
export function closeTurnOfMessage(userMessageId: string): Promise<MessageRow[]> {
  return closeTurns(sql`${messages.meta}->'turnMessageIds' @> jsonb_build_array(${userMessageId}::text)`);
}

/** Every streaming reply created before `before`, except conversations this process is answering right now. */
export function closeStaleTurns(before: Date, liveConversationIds: string[] = []): Promise<MessageRow[]> {
  const conds: SQL[] = [lt(messages.createdAt, before)];
  if (liveConversationIds.length) conds.push(notInArray(messages.conversationId, liveConversationIds));
  return closeTurns(and(...conds)!);
}

// ---------------------------------------------------------------------------
// Branches: every message points at its parent (messages.parent_id); the conversation remembers the leaf
// it currently ends at (conversations.active_leaf_id). The active branch is the leaf and its ancestors.
// ---------------------------------------------------------------------------

/** Walk cap when testing branch membership (a conversation longer than this is not expected). */
const BRANCH_WALK_MAX = 5000;

/** `fromId` and its ancestors, nearest first, at most `limit` ids (one recursive query; the cap also stops a cycle). */
export async function ancestorIds(exec: Tx | typeof db, fromId: string, limit = BRANCH_WALK_MAX): Promise<string[]> {
  const rows = await exec.execute<{ id: string }>(sql`
    WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM messages WHERE id = ${fromId}
      UNION ALL
      SELECT m.id, m.parent_id, c.depth + 1 FROM messages m JOIN chain c ON m.id = c.parent_id WHERE c.depth < ${limit - 1}
    )
    SELECT id FROM chain ORDER BY depth`);
  return [...rows].map((r) => r.id);
}

/**
 * Up to `limit` rows of the branch ending at `fromId` (inclusive), oldest first: the parent chain, not
 * created_at order. Assistant rows still streaming (another run in flight, or one that died mid-reply) are left out.
 */
export async function branchTranscript(fromId: string | null, limit = 20): Promise<MessageRow[]> {
  if (!fromId) return [];
  // a few streaming ghosts may sit on the chain: walk a little further than the rows returned
  const ids = await ancestorIds(db, fromId, limit * 2);
  if (!ids.length) return [];
  const rows = await db.select().from(messages).where(inArray(messages.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((m): m is MessageRow => !!m && !(m.role === "assistant" && m.status === "streaming"))
    .slice(0, limit)
    .reverse();
}

/**
 * Move the conversation's active leaf to `rowId` — only while it still is `expected` (compare-and-set): a user who
 * switched to another branch, or sent a new message, in the meantime keeps their leaf. Returns whether it moved.
 */
export async function moveLeaf(exec: Tx | typeof db, conversationId: string, rowId: string, expected: string | null): Promise<boolean> {
  const cond = and(eq(conversations.id, conversationId), expected === null ? sql`${conversations.activeLeafId} IS NULL` : eq(conversations.activeLeafId, expected));
  const moved = await exec.update(conversations).set({ activeLeafId: rowId }).where(cond).returning({ id: conversations.id });
  return moved.length > 0;
}

/** Insert a row below `values.parentId` and move the active leaf to it when the leaf still is that parent (one transaction). */
export async function insertOnBranch(values: NewMessage & { parentId: string | null }, opts: { tx?: Tx } = {}): Promise<MessageRow> {
  const run = async (tx: Tx) => {
    const [row] = await tx.insert(messages).values(values).returning();
    await moveLeaf(tx, values.conversationId, row!.id, values.parentId);
    return row!;
  };
  return opts.tx ? run(opts.tx) : db.transaction(run);
}

/**
 * Append a row to the branch that contains `anchorId` (an approval receipt below the reply that raised it; a team
 * turn's next responder below the turn's newest row): when the anchor is on the active branch (the leaf or one of
 * its ancestors) the row goes below the active leaf and becomes it — so a follow-up the user sent, or a receipt
 * that landed, below the anchor in the meantime does not strand it on a hidden side branch; otherwise (the user
 * moved to another branch since) it goes directly below the anchor and the leaf stays. Without an anchor it goes
 * below the active leaf.
 */
export async function appendToBranch(values: NewMessage, anchorId: string | null): Promise<MessageRow> {
  return db.transaction((tx) => appendIn(tx, values, anchorId));
}

async function appendIn(tx: Tx, values: NewMessage, anchorId: string | null): Promise<MessageRow> {
  const [conv] = await tx
    .select({ leaf: conversations.activeLeafId })
    .from(conversations)
    .where(eq(conversations.id, values.conversationId))
    .for("no key update");
  const leaf = conv?.leaf ?? null;
  const onActive = !anchorId || (leaf !== null && (await ancestorIds(tx, leaf)).includes(anchorId));
  const parentId = onActive ? (leaf ?? anchorId) : anchorId;
  return insertOnBranch({ ...values, parentId }, { tx });
}
