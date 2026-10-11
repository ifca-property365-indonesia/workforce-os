import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { conversations, db, messages } from "@wfos/db";
import { newestLeaf } from "@/lib/chat-thread";
import { body, notFound, route } from "@/lib/server/route";
import { conversationIn, threadView, treeOf } from "../thread";

type P = { id: string };

const schema = z.object({ messageId: z.string().uuid() });

/**
 * Switch versions: show the branch through `messageId`, down to its newest leaf (the latest edit / reply below it).
 * Returns the new branch, shaped like GET /api/conversations/[id].
 */
export const POST = route<P>("MEMBER", async ({ session, req, params }) => {
  const { messageId } = await body(req, schema);
  const c = await conversationIn(session.workspaceId, params.id);
  const [m] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, c.id)));
  if (!m) notFound();
  const updated = await db.transaction(async (tx) => {
    await conversationIn(session.workspaceId, c.id, tx, true);
    const leaf = newestLeaf(await treeOf(c.id, tx), m.id);
    const [row] = await tx.update(conversations).set({ activeLeafId: leaf }).where(eq(conversations.id, c.id)).returning();
    return row!;
  });
  return threadView(updated, session.workspaceId);
});
