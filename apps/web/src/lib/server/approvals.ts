import "server-only";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { approvals, audit, db, tasks } from "@wfos/db";
import { emailPayloadSchema, invoicePayloadSchema, webhookPayloadSchema } from "@wfos/shared";
import { HttpError } from "./auth";
import { notFound } from "./route";
import { publish, q } from "./queue";

function validatePayload(toolName: string, payload: Record<string, unknown>) {
  if (toolName === "send_email") return emailPayloadSchema.parse(payload);
  if (toolName === "send_invoice") return invoicePayloadSchema.parse(payload);
  if (toolName === "post_webhook") return webhookPayloadSchema.parse(payload);
  // a PRD handoff may only change who builds it and where; the approved PRD text stays as written
  if (toolName === "handoff_prd") return z.object({ developerId: z.string().uuid().nullable(), repositoryId: z.string().uuid().nullable() }).parse(payload);
  return payload;
}

export interface DecisionActor {
  userId: string;
  email: string;
  workspaceId: string;
  /** where the decision was made (audited) */
  via: "web" | "telegram";
}

export interface DecisionInput {
  decision: "approve" | "edit_approve" | "reject";
  editedPayload?: Record<string, unknown>;
  feedback?: string;
}

/**
 * Per-action human decision, shared by the Approvals page and Telegram buttons: Approve / Edit & Approve /
 * Reject with feedback (→ employee memory). The caller checks the actor's role.
 */
export async function decideApproval(actor: DecisionActor, approvalId: string, input: DecisionInput): Promise<{ ok: true }> {
  const session = actor;
  const [a] = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, session.workspaceId)));
  if (!a) notFound();
  if (a.status !== "PENDING") throw new HttpError(409, `Approval already ${a.status}`, { code: "approval_already_decided", status: a.status });

  if (input.decision === "reject") {
    const r = await db
      .update(approvals)
      .set({ status: "REJECTED", decidedBy: session.userId, decidedAt: new Date(), feedback: input.feedback ?? null })
      .where(and(eq(approvals.id, a.id), eq(approvals.status, "PENDING")))
      .returning({ id: approvals.id });
    if (!r.length) throw new HttpError(409, "Approval was decided concurrently", { code: "approval_decided_concurrently" });
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "approval.rejected", targetType: "approval", targetId: a.id, details: { toolName: a.toolName, title: a.title, feedback: input.feedback ?? null, via: actor.via } });
    await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "REJECTED" });
    await q.action({ kind: "rejected_approval", approvalId: a.id, workspaceId: session.workspaceId });
    return { ok: true as const };
  }

  // the task may have been cancelled or finished since the approval was requested
  if (a.taskId) {
    const [t] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, a.taskId));
    if (t && t.status !== "AWAITING_APPROVAL") {
      await db
        .update(approvals)
        .set({ status: "EXPIRED", executionResult: { ok: false, summary: `Task is ${t.status}; the action can no longer run.` } })
        .where(and(eq(approvals.id, a.id), eq(approvals.status, "PENDING")));
      await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "EXPIRED" });
      throw new HttpError(409, `The task is ${t.status.toLowerCase()}, so this action can no longer be approved.`, { code: "approval_task_closed", status: t.status });
    }
  }

  let edited: Record<string, unknown> | null = null;
  if (input.decision === "edit_approve" && a.toolName === "handoff_prd" && input.editedPayload) {
    const pick = validatePayload(a.toolName, input.editedPayload) as { developerId: string | null; repositoryId: string | null };
    input.editedPayload = { ...a.payload, developerId: pick.developerId, repositoryId: pick.repositoryId };
    edited = input.editedPayload;
  } else if (input.decision === "edit_approve") {
    // a push is approved for one exact commit; it can be approved or rejected, never rewritten
    if (a.toolName === "git_push") throw new HttpError(400, "A push can only be approved or rejected", { code: "push_not_editable" });
    if (!input.editedPayload) throw new HttpError(400, "editedPayload is required for Edit & Approve", { code: "edited_payload_required" });
    edited = validatePayload(a.toolName, input.editedPayload) as Record<string, unknown>;
  }
  const r = await db
    .update(approvals)
    .set({ status: "APPROVED", decidedBy: session.userId, decidedAt: new Date(), editedPayload: edited, feedback: input.feedback ?? null })
    .where(and(eq(approvals.id, a.id), eq(approvals.status, "PENDING")))
    .returning({ id: approvals.id });
  if (!r.length) throw new HttpError(409, "Approval was decided concurrently", { code: "approval_decided_concurrently" });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: edited ? "approval.edited_and_approved" : "approval.approved",
    targetType: "approval",
    targetId: a.id,
    details: { toolName: a.toolName, title: a.title, payload: a.payload, editedPayload: edited, via: actor.via },
  });
  await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "APPROVED" });
  await q.action({ kind: "execute_approval", approvalId: a.id, workspaceId: session.workspaceId });
  return { ok: true as const };
}
