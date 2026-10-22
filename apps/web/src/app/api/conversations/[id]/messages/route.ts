import { and, eq } from "drizzle-orm";
import { approvals, conversations, db, messages } from "@wfos/db";
import { approvalReplyDecision, hasRole } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { OWNER_ONLY_APPROVAL_TOOLS, decideApproval } from "@/lib/server/approvals";
import { route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";
import { saveChatAttachments } from "@/lib/server/uploads";
import { MAX_MESSAGE, checkLeaf, conversationIn, currentLeaf, expectedLeafOf, mentionMeta, messageDto } from "../thread";

/**
 * Send a chat message (multipart: content + optional files + optional expectedLeafId). Documents are indexed into the
 * knowledge base; images are kept for the employee to see. The message hangs below the thread's current end and
 * becomes its new end, in one transaction.
 *
 * A short "ya" / "tidak" (approvalReplyDecision) from an Admin while exactly one approval of this chat waits decides
 * that approval instead (not a LIVE release, which needs the Owner's step-up): the reply is kept in the thread as
 * handled, so the employee does not answer it as a new message.
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
  const reply = !files.length && hasRole(session.role, "ADMIN") ? approvalReplyDecision(content) : null;
  let decided: { approvalId: string; decision: "approve" | "reject" } | null = null;
  if (reply) {
    const waiting = await db
      .select({ id: approvals.id, toolName: approvals.toolName })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, session.workspaceId), eq(approvals.conversationId, c.id), eq(approvals.status, "PENDING")));
    if (waiting.length === 1 && !OWNER_ONLY_APPROVAL_TOOLS.has(waiting[0]!.toolName)) {
      await decideApproval({ userId: session.userId, email: session.email, workspaceId: session.workspaceId, via: "chat", role: session.role }, waiting[0]!.id, { decision: reply });
      decided = { approvalId: waiting[0]!.id, decision: reply };
    }
  }
  const attachments = await saveChatAttachments(session.workspaceId, session.userId, files);
  const meta = { ...(await mentionMeta(c, session.workspaceId, content)), ...(decided ? { approvalReply: decided } : {}) };
  // handledAt stays null: the chat run claims this message (and any sent right after it) as one turn.
  const m = await db.transaction(async (tx) => {
    const locked = await conversationIn(session.workspaceId, c.id, tx, true);
    const leaf = await currentLeaf(locked, tx);
    checkLeaf(expected, leaf);
    const [row] = await tx
      .insert(messages)
      .values({ conversationId: c.id, parentId: leaf, role: "user", content: content || "(see attachments)", attachments, meta, ...(decided ? { handledAt: new Date() } : {}) })
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
  // a reply that decided an approval is not a turn for the employee (the approval's receipt follows in the thread)
  if (!decided) await q.chat(c.id, m.id, session.workspaceId);
  return { message: dto, ...(decided ? { approval: decided } : {}) };
});
