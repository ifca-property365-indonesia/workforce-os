import { and, asc, eq } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

type P = { id: string };

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const [c] = await db.select().from(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  if (!c) notFound();
  const ms = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(asc(messages.createdAt));
  return { conversation: c, messages: ms };
});

export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  await db.delete(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  return { ok: true };
});
