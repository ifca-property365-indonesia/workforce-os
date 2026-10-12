import { eq } from "drizzle-orm";
import { conversations, db, messages } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";
import { saveChatAttachments } from "@/lib/server/uploads";
import { MAX_MESSAGE, checkLeaf, conversationIn, currentLeaf, expectedLeafOf, mentionMeta, messageDto } from "../thread";

/**
 * Send a chat message (multipart: content + optional files + optional expectedLeafId). Documents are indexed into the
 * knowledge base; images are kept for the employee to see. The message hangs below the thread's current end and
 * becomes its new end, in one transaction.
 */
export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const c = await conversationIn(session.workspaceId, params.id);
  // a JSON (or otherwise non-form) body makes formData() throw: that is the client's mistake, not a 500
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart/form-data", { code: "invalid_form" });
  }
  const content = String(form.get("content") ?? "").trim();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const expected = expectedLeafOf(form);
  if (!content && !files.length) throw new HttpError(400, "Message is empty", { code: "message_empty" });
  if (content.length > MAX_MESSAGE) throw new HttpError(400, "Message too long", { code: "message_too_long", max: MAX_MESSAGE });
  // checked before the uploads too, so a stale client does not index files for a message that is refused
  checkLeaf(expected, await currentLeaf(c));
  const attachments = await saveChatAttachments(session.workspaceId, session.userId, files);
  const meta = await mentionMeta(c, session.workspaceId, content);
  // handledAt stays null: the chat run claims this message (and any sent right after it) as one turn.
  const m = await db.transaction(async (tx) => {
    const locked = await conversationIn(session.workspaceId, c.id, tx, true);
    const leaf = await currentLeaf(locked, tx);
    checkLeaf(expected, leaf);
    const [row] = await tx
      .insert(messages)
      .values({ conversationId: c.id, parentId: leaf, role: "user", content: content || "(see attachments)", attachments, meta })
      .returning();
    const title = locked.title === "New chat" && content ? { title: content.slice(0, 60) } : {};
    await tx
      .update(conversations)
      .set({ activeLeafId: row!.id, updatedAt: new Date(), ...title })
      .where(eq(conversations.id, c.id));
    return row!;
  });
  const dto = messageDto(m);
  await publish(session.workspaceId, { type: "chat.message", conversationId: c.id, message: dto });
  await q.chat(c.id, m.id, session.workspaceId);
  return { message: dto };
});
