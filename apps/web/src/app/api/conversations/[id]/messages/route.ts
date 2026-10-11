import { and, eq } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import type { ChatMessageDTO, MessageMeta } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { notFound, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";
import { saveDocument } from "@/lib/server/uploads";
import { parseMentions } from "@/lib/mentions";
import { teamRoster } from "@/lib/server/teams";

/** Send a chat message (multipart: content + optional files). Files are indexed into the knowledge base. */
export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const [c] = await db.select().from(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  if (!c) notFound();
  // a JSON (or otherwise non-form) body makes formData() throw: that is the client's mistake, not a 500
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart/form-data", { code: "invalid_form" });
  }
  const content = String(form.get("content") ?? "").trim();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!content && !files.length) throw new HttpError(400, "Message is empty", { code: "message_empty" });
  if (content.length > 20000) throw new HttpError(400, "Message too long", { code: "message_too_long", max: 20000 });
  const attachments = [];
  for (const f of files.slice(0, 5)) {
    const doc = await saveDocument(session.workspaceId, session.userId, f);
    attachments.push({ name: doc.name, size: doc.size, documentId: doc.id });
  }
  // team chats: who was @mentioned decides who answers (the content itself is stored unchanged)
  const meta: MessageMeta = {};
  if (c.teamId && content.includes("@")) {
    const { mentions, mentionAll } = parseMentions(content, await teamRoster(session.workspaceId, c.teamId));
    if (mentions.length) meta.mentions = mentions;
    if (mentionAll) meta.mentionAll = true;
  }
  // handledAt stays null: the chat run claims this message (and any sent right after it) as one turn.
  const [m] = await db.insert(messages).values({ conversationId: c.id, role: "user", content: content || "(see attachments)", attachments, meta }).returning();
  if (c.title === "New chat" && content) {
    await db.update(conversations).set({ title: content.slice(0, 60) }).where(eq(conversations.id, c.id));
  } else {
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, c.id));
  }
  const dto: ChatMessageDTO = {
    id: m!.id,
    conversationId: c.id,
    role: "user",
    content: m!.content,
    attachments,
    status: m!.status,
    meta: m!.meta,
    createdAt: m!.createdAt.toISOString(),
  };
  await publish(session.workspaceId, { type: "chat.message", conversationId: c.id, message: dto });
  await q.chat(c.id, m!.id, session.workspaceId);
  return { message: dto };
});
