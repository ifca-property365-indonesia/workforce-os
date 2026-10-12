import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { approvals, audit, conversations, db, messages } from "@wfos/db";
import { publicAttachment, type ChatApprovalDTO, type ChatMessageDTO, type MessageMeta } from "@wfos/shared";
import { activeBranch, effectiveLeaf, versionsOf, type BranchInfo, type TreeNode } from "@/lib/chat-thread";
import { HttpError } from "@/lib/server/auth";
import { notFound } from "@/lib/server/route";
import { publish } from "@/lib/server/queue";
import { parseMentions } from "@/lib/mentions";
import { teamRoster } from "@/lib/server/teams";

/** Shared by the conversation routes: loading the active branch, the leaf check, "is a reply streaming". */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Q = typeof db | Tx;
type MessageRow = typeof messages.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;

export const MAX_MESSAGE = 20000;

/** An `expectedLeafId` form field: absent = no check, empty = "the thread was empty". */
export function expectedLeafOf(form: FormData): string | null | undefined {
  if (!form.has("expectedLeafId")) return undefined;
  return String(form.get("expectedLeafId") ?? "") || null;
}

/** A streaming reply older than this has no run behind it any more (the worker's CHAT_TURN_STALE_MS). */
const STREAM_STALE_MS = 15 * 60_000;

type GuardFinding = ChatApprovalDTO["guardFindings"][number];
const SEVERITIES = new Set<string>(["low", "medium", "high"]);

/** The stored jsonb is untyped: keep only well-formed findings, so the card never renders garbage. */
function guardFindingsOf(raw: unknown): GuardFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((g): GuardFinding[] => {
    if (!g || typeof g !== "object") return [];
    const { rule, severity, excerpt } = g as Record<string, unknown>;
    if (typeof rule !== "string" || typeof severity !== "string" || !SEVERITIES.has(severity)) return [];
    return [{ rule, severity: severity as GuardFinding["severity"], excerpt: typeof excerpt === "string" ? excerpt : "" }];
  });
}

/** This workspace's conversation, or 404 (another workspace's id looks exactly like a missing one). */
export async function conversationIn(workspaceId: string, id: string, q: Q = db, lock = false): Promise<ConversationRow> {
  const base = q.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.workspaceId, workspaceId)));
  const [c] = lock ? await base.for("update") : await base;
  if (!c) notFound();
  return c;
}

/** The tree's shape (no content): enough to find the leaf and the versions of a message. */
export function treeOf(conversationId: string, q: Q = db): Promise<TreeNode[]> {
  return q
    .select({ id: messages.id, parentId: messages.parentId, role: messages.role, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/** Where the thread ends right now (what a new message hangs below, and what `expectedLeafId` is checked against). */
export async function currentLeaf(c: ConversationRow, q: Q = db): Promise<string | null> {
  return effectiveLeaf(await treeOf(c.id, q), c.activeLeafId);
}

/** 409 when the client acted on a thread that has moved on since it last loaded it. */
export function checkLeaf(expected: unknown, actual: string | null) {
  if (expected === undefined) return;
  if ((expected ?? null) !== actual) throw new HttpError(409, "The conversation changed", { code: "conversation_changed", activeLeafId: actual });
}

/** Is a reply being written in this conversation (a live, not stale, streaming assistant row)? */
export async function replyStreaming(conversationId: string, q: Q = db): Promise<boolean> {
  const [row] = await q
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
        eq(messages.status, "streaming"),
        gt(messages.createdAt, new Date(Date.now() - STREAM_STALE_MS)),
      ),
    )
    .limit(1);
  return !!row;
}

/** Team chats: who was @mentioned decides who answers (the content itself is stored unchanged). */
export async function mentionMeta(c: ConversationRow, workspaceId: string, content: string, base: MessageMeta = {}): Promise<MessageMeta> {
  const meta: MessageMeta = { ...base };
  delete meta.mentions;
  delete meta.mentionAll;
  if (c.teamId && content.includes("@")) {
    const { mentions, mentionAll } = parseMentions(content, await teamRoster(workspaceId, c.teamId));
    if (mentions.length) meta.mentions = mentions;
    if (mentionAll) meta.mentionAll = true;
  }
  return meta;
}

export function messageDto(m: MessageRow, extra: { approvals?: ChatApprovalDTO[]; branch?: BranchInfo } = {}): ChatMessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    employeeId: m.employeeId,
    taskId: m.taskId,
    attachments: m.attachments.map(publicAttachment),
    status: m.status,
    meta: m.meta,
    parentId: m.parentId,
    ...(extra.approvals ? { approvals: extra.approvals } : {}),
    ...(extra.branch ? { branch: extra.branch } : {}),
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * An edit or a regenerate abandons a reply (and everything below it): approvals those messages raised and nobody
 * decided yet must not stay executable — the person retracted what led to them. Runs inside the caller's
 * transaction (only still-PENDING rows change, so a decision that won the race stays as it was); `announce` the
 * result after the commit. A version switch does not call this: switching back must find its approvals intact.
 */
export async function expireAbandonedApprovals(tx: Tx, workspaceId: string, messageIds: string[], userId: string, feedback: string) {
  if (!messageIds.length) return [];
  return tx
    .update(approvals)
    .set({ status: "EXPIRED", feedback, decidedBy: userId, decidedAt: new Date(), executionResult: { ok: false, summary: feedback } })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "PENDING"), inArray(approvals.messageId, messageIds)))
    .returning({ id: approvals.id, messageId: approvals.messageId, conversationId: approvals.conversationId, toolName: approvals.toolName, title: approvals.title });
}

/** After the commit: tell open views, and leave an audit trail of every approval an edit or regenerate expired. */
export async function announceExpired(
  session: { workspaceId: string; userId: string; email: string },
  expired: Awaited<ReturnType<typeof expireAbandonedApprovals>>,
  via: "edit" | "regenerate",
) {
  for (const a of expired) {
    await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "EXPIRED" });
    await audit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      actorLabel: session.email,
      action: "approval.expired_by_edit",
      targetType: "approval",
      targetId: a.id,
      details: { via, conversationId: a.conversationId, messageId: a.messageId, toolName: a.toolName, title: a.title },
    });
  }
}

/** For approvals raised in chat: which of them hang on a message that is not on its conversation's active branch. */
export async function offBranchApprovals(workspaceId: string, rows: { id: string; conversationId: string | null; messageId: string | null }[]): Promise<Set<string>> {
  const convIds = [...new Set(rows.flatMap((r) => (r.conversationId && r.messageId ? [r.conversationId] : [])))];
  const out = new Set<string>();
  if (!convIds.length) return out;
  const convs = await db
    .select({ id: conversations.id, activeLeafId: conversations.activeLeafId })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), inArray(conversations.id, convIds)));
  const shapes = await db
    .select({ id: messages.id, parentId: messages.parentId, role: messages.role, createdAt: messages.createdAt, conversationId: messages.conversationId })
    .from(messages)
    .where(inArray(messages.conversationId, convs.map((c) => c.id)));
  const byConv = new Map<string, TreeNode[]>();
  for (const m of shapes) {
    const list = byConv.get(m.conversationId) ?? [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }
  const onBranch = new Map(convs.map((c) => [c.id, new Set(activeBranch(byConv.get(c.id) ?? [], c.activeLeafId).map((n) => n.id))]));
  for (const r of rows) {
    if (!r.conversationId || !r.messageId) continue;
    const branch = onBranch.get(r.conversationId);
    if (branch && !branch.has(r.messageId)) out.add(r.id);
  }
  return out;
}

/**
 * What GET /api/conversations/[id] returns: the active branch only (root first), each message with the
 * approvals it raised and, when it has other versions, its place among them. Only the tree's shape is read for
 * the whole conversation; full rows (content, attachments, meta) are loaded for the branch shown.
 */
export async function threadView(c: ConversationRow, workspaceId: string) {
  const shape = await treeOf(c.id);
  const leaf = effectiveLeaf(shape, c.activeLeafId);
  const path = activeBranch(shape, c.activeLeafId);
  const ids = path.map((m) => m.id);
  const full = ids.length ? await db.select().from(messages).where(and(eq(messages.conversationId, c.id), inArray(messages.id, ids))) : [];
  const rowById = new Map(full.map((m) => [m.id, m]));
  const branch = path.flatMap((n) => {
    const row = rowById.get(n.id);
    return row ? [row] : [];
  });
  // approvals a chat run raised, shown inline under the assistant message that raised them
  const rows = ids.length
    ? await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.workspaceId, workspaceId), inArray(approvals.messageId, ids)))
        .orderBy(asc(approvals.createdAt), asc(approvals.id))
    : [];
  const byMessage = new Map<string, ChatApprovalDTO[]>();
  for (const a of rows) {
    const list = byMessage.get(a.messageId!) ?? [];
    list.push({
      id: a.id,
      toolName: a.toolName,
      title: a.title,
      reason: a.reason,
      status: a.status,
      payload: a.payload,
      editedPayload: a.editedPayload,
      feedback: a.feedback,
      executionResult: a.executionResult,
      guardFindings: guardFindingsOf(a.guardFindings),
      decidedAt: a.decidedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    });
    byMessage.set(a.messageId!, list);
  }
  // a thread without a stored leaf predates branching (every row a root): no versions to offer
  const versions = c.activeLeafId ? versionsOf(shape) : undefined;
  const out: ChatMessageDTO[] = branch.map((m) => messageDto(m, { approvals: byMessage.get(m.id), branch: versions?.(m) }));
  return { conversation: { ...c, activeLeafId: leaf }, messages: out, activeLeafId: leaf };
}
