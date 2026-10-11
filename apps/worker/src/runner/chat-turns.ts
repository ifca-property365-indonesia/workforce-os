import { and, eq, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import type { ChatMessageDTO } from "@wfos/shared";
import { publish } from "../lib/redis";
import { log } from "../lib/logger";

type MessageRow = typeof messages.$inferSelect;

/** Shown when a reply was left half-written (process died, job stalled); same shape as runChat's error replies. */
export const CHAT_INTERRUPTED_TEXT = "⚠️ Runner error: the reply stopped without finishing.";

/** A streaming reply older than this has no run behind it any more. */
export const CHAT_TURN_STALE_MS = 15 * 60_000;

export function chatMessageDto(m: MessageRow): ChatMessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    employeeId: m.employeeId,
    taskId: m.taskId,
    attachments: m.attachments,
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
