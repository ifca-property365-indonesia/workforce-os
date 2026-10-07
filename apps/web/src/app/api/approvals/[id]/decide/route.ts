import { and, eq } from "drizzle-orm";
import { approvals, audit, db } from "@wfos/db";
import { approvalDecisionSchema, emailPayloadSchema, invoicePayloadSchema, webhookPayloadSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";

function validatePayload(toolName: string, payload: Record<string, unknown>) {
  if (toolName === "send_email") return emailPayloadSchema.parse(payload);
  if (toolName === "send_invoice") return invoicePayloadSchema.parse(payload);
  if (toolName === "post_webhook") return webhookPayloadSchema.parse(payload);
  return payload;
}

/** Per-action human decision. Approve / Edit & Approve / Reject with feedback (→ employee memory). */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const input = await body(req, approvalDecisionSchema);
  const [a] = await db.select().from(approvals).where(and(eq(approvals.id, params.id), eq(approvals.workspaceId, session.workspaceId)));
  if (!a) notFound();
  if (a.status !== "PENDING") throw new HttpError(409, `Approval already ${a.status}`);

  if (input.decision === "reject") {
    const r = await db
      .update(approvals)
      .set({ status: "REJECTED", decidedBy: session.userId, decidedAt: new Date(), feedback: input.feedback ?? null })
      .where(and(eq(approvals.id, a.id), eq(approvals.status, "PENDING")))
      .returning({ id: approvals.id });
    if (!r.length) throw new HttpError(409, "Approval was decided concurrently");
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "approval.rejected", targetType: "approval", targetId: a.id, details: { toolName: a.toolName, title: a.title, feedback: input.feedback ?? null } });
    await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "REJECTED" });
    await q.action({ kind: "rejected_approval", approvalId: a.id, workspaceId: session.workspaceId });
    return { ok: true };
  }

  let edited: Record<string, unknown> | null = null;
  if (input.decision === "edit_approve") {
    if (!input.editedPayload) throw new HttpError(400, "editedPayload is required for Edit & Approve");
    edited = validatePayload(a.toolName, input.editedPayload) as Record<string, unknown>;
  }
  const r = await db
    .update(approvals)
    .set({ status: "APPROVED", decidedBy: session.userId, decidedAt: new Date(), editedPayload: edited, feedback: input.feedback ?? null })
    .where(and(eq(approvals.id, a.id), eq(approvals.status, "PENDING")))
    .returning({ id: approvals.id });
  if (!r.length) throw new HttpError(409, "Approval was decided concurrently");
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: edited ? "approval.edited_and_approved" : "approval.approved",
    targetType: "approval",
    targetId: a.id,
    details: { toolName: a.toolName, title: a.title, payload: a.payload, editedPayload: edited },
  });
  await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "APPROVED" });
  await q.action({ kind: "execute_approval", approvalId: a.id, workspaceId: session.workspaceId });
  return { ok: true };
});
