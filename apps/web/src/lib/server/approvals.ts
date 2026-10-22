import "server-only";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { appEnvironments, appReleases, approvals, audit, db, employees, tasks, teams, withEmployeeRevision } from "@wfos/db";
import {
  alwaysAllowEntry,
  effectiveAutonomy,
  emailPayloadSchema,
  invoicePayloadSchema,
  isWithinReleaseWindow,
  matchToolPermission,
  requestReleasePayloadSchema,
  webhookPayloadSchema,
  type AllowListEntry,
  type Role,
} from "@wfos/shared";
import { nextReleaseWindowOpening } from "@/lib/release-window";
import { HttpError } from "./auth";
import { notFound } from "./route";
import { publish, q } from "./queue";

/** what Edit & Approve may change on a PRD handoff: the division (older payloads: the developer) and the repository */
const handoffEditSchema = z.object({
  teamId: z.string().uuid().nullable().optional(),
  developerId: z.string().uuid().nullable().optional(),
  repositoryId: z.string().uuid().nullable().default(null),
});

function validatePayload(toolName: string, payload: Record<string, unknown>) {
  if (toolName === "send_email") return emailPayloadSchema.parse(payload);
  if (toolName === "send_invoice") return invoicePayloadSchema.parse(payload);
  if (toolName === "post_webhook") return webhookPayloadSchema.parse(payload);
  // a PRD handoff may only change which division builds it and where; the approved PRD text stays as written
  if (toolName === "handoff_prd") return handoffEditSchema.parse(payload);
  return payload;
}

export interface DecisionActor {
  userId: string;
  email: string;
  workspaceId: string;
  /** where the decision was made (audited) */
  via: "web" | "telegram" | "chat";
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
  /** with approve on the web: also add alwaysAllowEntry to the employee's allow-list (see addAlwaysAllow) */
  alwaysAllow?: boolean;
}

/** two entries that allow the same thing (the note does not count; jsonb does not keep key order) */
function sameEntry(a: AllowListEntry, b: AllowListEntry): boolean {
  const key = (e: AllowListEntry) =>
    JSON.stringify([e.tool, [...e.recipientDomains].sort(), [...(e.recipients ?? [])].sort(), [...e.clientIds].sort(), e.maxAmount ?? null, e.clientContactsOnly ?? false]);
  return key(a) === key(b);
}

/**
 * "Always allow": the entry goes on the employee's allow-list and the tool's autonomy becomes CLOSE (allow-listed
 * actions run, everything else still asks), recorded as an employee revision by the person. Runs inside the
 * revision's transaction together with the approval itself.
 */
async function addAlwaysAllow(tx: Parameters<Parameters<typeof withEmployeeRevision>[3]>[0], employeeId: string, entry: AllowListEntry) {
  const [e] = await tx.select({ toolPermissions: employees.toolPermissions, allowList: employees.allowList, autonomyLevel: employees.autonomyLevel }).from(employees).where(eq(employees.id, employeeId));
  if (!e) return;
  const allowList = e.allowList.some((x) => sameEntry(x, entry)) ? e.allowList : [...e.allowList, entry];
  const perm = matchToolPermission(entry.tool, e.toolPermissions);
  const toolPermissions =
    perm && effectiveAutonomy(entry.tool, e.autonomyLevel, e.toolPermissions) !== "CLOSE" ? e.toolPermissions.map((p) => (p === perm ? { ...p, autonomy: "CLOSE" as const } : p)) : e.toolPermissions;
  await tx.update(employees).set({ allowList, toolPermissions, updatedAt: new Date() }).where(eq(employees.id, employeeId));
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
  let always: AllowListEntry | null = null;
  if (input.alwaysAllow) {
    if (input.decision !== "approve") throw new HttpError(400, "Always allow goes with a plain approve", { code: "always_allow_approve_only" });
    if (actor.via !== "web") throw new HttpError(403, "Choose always allow on the web", { code: "always_allow_web_only" });
    always = a.employeeId ? alwaysAllowEntry(a) : null;
    if (!always) throw new HttpError(409, "This action cannot be allowed for good; approve it once", { code: "always_allow_not_offered" });
  }

  // the task may have been cancelled or finished since the approval was requested
  if (a.taskId) {
    const [t] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, a.taskId));
    // still working (a run in flight, or queued for the next one): the approval stays PENDING; when the run ends the
    // task waits for it (AWAITING_APPROVAL) and it can be decided then. Expiring it here lost the action for good.
    if (t && (t.status === "RUNNING" || t.status === "QUEUED")) {
      throw new HttpError(409, "The employee is still working on this task; decide once the run has ended", { code: "approval_task_running", status: t.status });
    }
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
    const pick = handoffEditSchema.parse(input.editedPayload);
    const next: Record<string, unknown> = { ...a.payload, repositoryId: pick.repositoryId };
    if (pick.teamId !== undefined) {
      // the division must be one of this workspace's; its name travels with the payload (the preview shows it)
      const [team] = pick.teamId
        ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(and(eq(teams.id, pick.teamId), eq(teams.workspaceId, session.workspaceId)))
        : [];
      if (pick.teamId && !team) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
      next.teamId = team?.id ?? null;
      next.teamName = team?.name ?? null;
    }
    // a payload made before divisions keeps its developer choice
    if (pick.developerId !== undefined && "developerId" in a.payload) next.developerId = pick.developerId;
    input.editedPayload = next;
    edited = next;
  } else if (input.decision === "edit_approve") {
    // a push is approved for one exact commit; it can be approved or rejected, never rewritten
    if (a.toolName === "git_push") throw new HttpError(400, "A push can only be approved or rejected", { code: "push_not_editable" });
    // a preview is approved for the exact pushed commit and the changes shown; the executor re-checks that commit
    if (a.toolName === "request_preview") throw new HttpError(400, "A preview can only be approved or rejected", { code: "preview_not_editable" });
    // a LIVE release is approved for the exact preview release (commit) and the changes shown
    if (a.toolName === "request_release") throw new HttpError(400, "A LIVE release can only be approved or rejected", { code: "release_not_editable" });
    // a catalog skill is approved for the exact text, files and license shown, at one commit
    if (a.toolName === "install_skill") throw new HttpError(400, "A skill install can only be approved or rejected", { code: "skill_install_not_editable" });
    if (!input.editedPayload) throw new HttpError(400, "editedPayload is required for Edit & Approve", { code: "edited_payload_required" });
    edited = validatePayload(a.toolName, input.editedPayload) as Record<string, unknown>;
  }
  const approve = (database: Pick<typeof db, "update">) =>
    database
      .update(approvals)
      .set({ status: "APPROVED", decidedBy: session.userId, decidedAt: new Date(), editedPayload: edited, feedback: input.feedback ?? null })
      .where(and(eq(approvals.id, a.id), eq(approvals.status, "PENDING")))
      .returning({ id: approvals.id });
  const entry = always;
  const r = entry
    ? await withEmployeeRevision(db, a.employeeId!, { workspaceId: session.workspaceId, source: "person", actorUserId: session.userId, actorLabel: session.email, note: `Always allow: ${a.title}` }, async (tx) => {
        const rows = await approve(tx);
        // decided concurrently: the allow-list stays as it was (the revision records nothing)
        if (rows.length) await addAlwaysAllow(tx, a.employeeId!, entry);
        return rows;
      })
    : await approve(db);
  if (!r.length) throw new HttpError(409, "Approval was decided concurrently", { code: "approval_decided_concurrently" });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: edited ? "approval.edited_and_approved" : "approval.approved",
    targetType: "approval",
    targetId: a.id,
    details: { toolName: a.toolName, title: a.title, payload: a.payload, editedPayload: edited, via: actor.via, ...(entry ? { alwaysAllow: entry } : {}) },
  });
  if (entry) {
    await audit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      actorLabel: session.email,
      action: "employee.allow_list_added",
      targetType: "employee",
      targetId: a.employeeId!,
      details: { entry, fromApproval: a.id },
    });
  }
  await publish(session.workspaceId, { type: "approval.updated", approvalId: a.id, status: "APPROVED" });
  await q.action({ kind: "execute_approval", approvalId: a.id, workspaceId: session.workspaceId });
  return { ok: true as const };
}
