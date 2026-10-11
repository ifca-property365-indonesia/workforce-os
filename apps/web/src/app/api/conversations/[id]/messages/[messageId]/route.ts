import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { conversations, db, messages } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";
import { control, publish, q } from "@/lib/server/queue";
import { saveDocument } from "@/lib/server/uploads";
import { descendantsOf } from "@/lib/chat-thread";
import {
  MAX_MESSAGE,
  announceExpired,
  checkLeaf,
  conversationIn,
  currentLeaf,
  expectedLeafOf,
  expireAbandonedApprovals,
  mentionMeta,
  messageDto,
  replyStreaming,
  treeOf,
} from "../../thread";

type P = { id: string; messageId: string };

const editSchema = z.object({ content: z.string().max(MAX_MESSAGE * 2), expectedLeafId: z.string().uuid().nullable().optional() });

/** JSON {content, expectedLeafId} or multipart (content, expectedLeafId, optional extra files) like POST …/messages. */
async function editInput(req: NextRequest) {
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "Expected multipart/form-data", { code: "invalid_form" });
    }
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    return { content: String(form.get("content") ?? "").trim(), expected: expectedLeafOf(form), files };
  }
  const b = await body(req, editSchema);
  return { content: b.content.trim(), expected: b.expectedLeafId, files: [] as File[] };
}

/**
 * Edit a user message: the original stays (as an older version) and a sibling with the new text becomes the end of
 * the thread. A reply still streaming on the old branch is stopped, and the new message is answered. Approvals
 * still pending below the original (the replies the edit retracts) expire in the same transaction.
 */
export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const c = await conversationIn(session.workspaceId, params.id);
  const [original] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, params.messageId), eq(messages.conversationId, c.id)));
  if (!original) notFound();
  if (original.role !== "user") throw new HttpError(400, "Only messages written by a person can be edited", { code: "message_not_editable" });
  const { content, expected, files } = await editInput(req);
  const attachments = [...original.attachments];
  if (!content && !attachments.length && !files.length) throw new HttpError(400, "Message is empty", { code: "message_empty" });
  if (content.length > MAX_MESSAGE) throw new HttpError(400, "Message too long", { code: "message_too_long", max: MAX_MESSAGE });
  checkLeaf(expected, await currentLeaf(c));
  for (const f of files.slice(0, Math.max(0, 5 - attachments.length))) {
    const doc = await saveDocument(session.workspaceId, session.userId, f);
    attachments.push({ name: doc.name, size: doc.size, documentId: doc.id });
  }
  // the original's meta carries over (e.g. untrusted), but who is @mentioned is read from the new text
  const meta = await mentionMeta(c, session.workspaceId, content, original.meta);
  const { row, streaming, expired } = await db.transaction(async (tx) => {
    const locked = await conversationIn(session.workspaceId, c.id, tx, true);
    checkLeaf(expected, await currentLeaf(locked, tx));
    const streaming = await replyStreaming(c.id, tx);
    const abandoned = descendantsOf(await treeOf(c.id, tx), original.id, { self: false });
    const expired = await expireAbandonedApprovals(tx, session.workspaceId, abandoned, session.userId, "Superseded by an edited message");
    const [row] = await tx
      .insert(messages)
      .values({ conversationId: c.id, parentId: original.parentId, role: "user", content: content || "(see attachments)", attachments, meta })
      .returning();
    // the title was taken from the first message: follow its edit
    const title = !original.parentId && content && locked.title === original.content.slice(0, 60) ? { title: content.slice(0, 60) } : {};
    await tx
      .update(conversations)
      .set({ activeLeafId: row!.id, updatedAt: new Date(), ...title })
      .where(eq(conversations.id, c.id));
    return { row: row!, streaming, expired };
  });
  await announceExpired(session, expired, "edit");
  // stop the old branch's reply before the new turn starts, so it neither keeps writing nor blocks the claim
  if (streaming) await control({ type: "abort_conversation", conversationId: c.id });
  const dto = messageDto(row);
  await publish(session.workspaceId, { type: "chat.message", conversationId: c.id, message: dto });
  await q.chat(c.id, row.id, session.workspaceId);
  return { message: dto, activeLeafId: row.id };
});
