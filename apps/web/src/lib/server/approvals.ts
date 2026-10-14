import "server-only";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { appEnvironments, appReleases, approvals, audit, db, tasks } from "@wfos/db";
import { emailPayloadSchema, invoicePayloadSchema, isWithinReleaseWindow, requestReleasePayloadSchema, webhookPayloadSchema, type Role } from "@wfos/shared";
import { nextReleaseWindowOpening } from "@/lib/release-window";
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
  /** the actor's role in the workspace (the caller already checked Admin) */
  role: Role;
  /** web only: confirms a fresh password + 2FA step-up (throws step_up_required) */
  stepUp?: () => Promise<void>;
}

/**
 * Approvals only the Owner may decide, approve or reject, on the web with a fresh step-up: a LIVE release reaches the
 * client's real site. Never from a Telegram button, never edited.
 */
export const OWNER_ONLY_APPROVAL_TOOLS: ReadonlySet<string> = new Set(["request_release"]);

/** a proposed LIVE release is approved within this long, else the Developer asks again (LIVE may have moved on) */
export const RELEASE_REQUEST_TTL_MS = 24 * 3_600_000;

/**
 * Before a request_release is approved: not older than RELEASE_REQUEST_TTL_MS (release_request_expired), LIVE still
 * runs the commit the request was made against (release_request_stale), and LIVE's release window is open now
 * (live_outside_window, with the next opening). Rejecting skips all of this.
 */
async function assertReleaseApprovable(a: typeof approvals.$inferSelect, now = new Date()) {
  if (now.getTime() - a.createdAt.getTime() > RELEASE_REQUEST_TTL_MS) {
    throw new HttpError(409, "This LIVE release request is too old", { code: "release_request_expired" });
  }
  const parsed = requestReleasePayloadSchema.safeParse(a.payload);
  if (!parsed.success) throw new HttpError(409, "This LIVE release request no longer matches LIVE", { code: "release_request_stale" });
  const p = parsed.data;
  const [env] = await db
    .select({ id: appEnvironments.id, releaseWindow: appEnvironments.releaseWindow, currentCommit: appReleases.commit })
    .from(appEnvironments)
    .leftJoin(appReleases, eq(appReleases.id, appEnvironments.currentReleaseId))
    .where(and(eq(appEnvironments.id, p.environmentId), eq(appEnvironments.appId, p.appId), eq(appEnvironments.workspaceId, a.workspaceId), eq(appEnvironments.kind, "live")));
  if (!env || (env.currentCommit ?? null) !== p.currentCommit) {
    throw new HttpError(409, "LIVE changed since this request", { code: "release_request_stale" });
  }
  const w = env.releaseWindow;
  if (w && !isWithinReleaseWindow(w, now)) {
    const opensAt = nextReleaseWindowOpening(w, now)?.toISOString() ?? "";
    throw new HttpError(409, "Outside the release window", { code: "live_outside_window", start: w.start, end: w.end, timeZone: w.timeZone, days: w.days, opensAt });
  }
}

/** The Owner-only rule for one approval: 403 from Telegram (approve on the web) or below Owner, then the step-up. */
async function assertMayDecide(actor: DecisionActor, toolName: string) {
  if (!OWNER_ONLY_APPROVAL_TOOLS.has(toolName)) return;
  if (actor.via !== "web") throw new HttpError(403, "Decide this LIVE release on the web", { code: "release_web_only" });
  if (actor.role !== "OWNER") throw new HttpError(403, "Requires OWNER role", { code: "role_required", role: "OWNER" });
  if (!actor.stepUp) throw new HttpError(401, "Confirm with your password and authenticator code", { code: "step_up_required" });
  await actor.stepUp();
}

export interface DecisionInput {
  decision: "approve" | "edit_approve" | "reject";
  editedPayload?: Record<string, unknown>;
  feedback?: string;
}

/**
 * Per-action human decision, shared by the Approvals page and Telegram buttons: Approve / Edit & Approve /
 * Reject with feedback (→ employee memory). The caller checks the actor's role (Admin); Owner-only approvals
 * (OWNER_ONLY_APPROVAL_TOOLS) are checked here.
 */
export async function decideApproval(actor: DecisionActor, approvalId: string, input: DecisionInput): Promise<{ ok: true }> {
  const session = actor;
  const [a] = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, session.workspaceId)));
  if (!a) notFound();
  await assertMayDecide(actor, a.toolName);
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

  if (a.toolName === "request_release" && input.decision === "approve") await assertReleaseApprovable(a);

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
    // a preview is approved for the exact pushed commit and the changes shown; the executor re-checks that commit
    if (a.toolName === "request_preview") throw new HttpError(400, "A preview can only be approved or rejected", { code: "preview_not_editable" });
    // a LIVE release is approved for the exact preview release (commit) and the changes shown
    if (a.toolName === "request_release") throw new HttpError(400, "A LIVE release can only be approved or rejected", { code: "release_not_editable" });
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
