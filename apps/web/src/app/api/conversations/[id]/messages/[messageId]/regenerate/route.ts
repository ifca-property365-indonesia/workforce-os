import { and, eq } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { notFound, route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";
import { descendantsOf } from "@/lib/chat-thread";
import { announceExpired, conversationIn, expireAbandonedApprovals, replyStreaming, treeOf } from "../../../thread";

type P = { id: string; messageId: string };

/**
 * Regenerate a reply: the user message it answers is answered again, as a new version beside this one. The thread
 * is cut back to that user message (later messages stay on the old branch); the new reply lands below it.
 * The replaced turn (the reply below that user message on the way to this one, and all below it) is retracted:
 * its still-pending approvals expire in the same transaction. Double submits collapse into one job (queue jobId).
 */
export const POST = route<P>("MEMBER", async ({ session, params }) => {
  const c = await conversationIn(session.workspaceId, params.id);
  const [target] = await db
    .select({ id: messages.id, role: messages.role })
    .from(messages)
    .where(and(eq(messages.id, params.messageId), eq(messages.conversationId, c.id)));
  if (!target) notFound();
  if (target.role !== "assistant") throw new HttpError(400, "Only replies can be regenerated", { code: "message_not_regenerable" });
  const { userMessageId, expired } = await db.transaction(async (tx) => {
    await conversationIn(session.workspaceId, c.id, tx, true);
    if (await replyStreaming(c.id, tx)) throw new HttpError(409, "A reply is still being written", { code: "reply_in_progress" });
    // the prompt: the nearest user message above (in a team turn, replies hang below one another)
    const tree = await treeOf(c.id, tx);
    const byId = new Map(tree.map((n) => [n.id, n]));
    const seen = new Set<string>();
    let at = byId.get(target.id);
    // the first reply of the turn being replaced (in a team turn, the replies above the target are part of it)
    let turn = at;
    while (at && at.role !== "user" && at.parentId && !seen.has(at.id)) {
      seen.add(at.id);
      turn = at;
      at = byId.get(at.parentId);
    }
    if (!at || at.role !== "user" || !turn) throw new HttpError(400, "There is no message to answer again", { code: "message_not_regenerable" });
    await tx.update(conversations).set({ activeLeafId: at.id, updatedAt: new Date() }).where(eq(conversations.id, c.id));
    const expired = await expireAbandonedApprovals(tx, session.workspaceId, descendantsOf(tree, turn.id), session.userId, "Superseded by a regenerated reply");
    return { userMessageId: at.id, expired };
  });
  await announceExpired(session, expired, "regenerate");
  await q.chatRegenerate(c.id, userMessageId, session.workspaceId);
  return { ok: true, userMessageId };
});
