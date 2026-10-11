import { and, asc, eq } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import type { ChatMessageDTO } from "@wfos/shared";
import { notFound, route } from "@/lib/server/route";

type P = { id: string };

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const [c] = await db.select().from(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  if (!c) notFound();
  const ms = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(asc(messages.createdAt), asc(messages.id));
  const out: ChatMessageDTO[] = ms.map((m) => ({
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
  }));
  return { conversation: c, messages: out };
});

export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  await db.delete(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  return { ok: true };
});
