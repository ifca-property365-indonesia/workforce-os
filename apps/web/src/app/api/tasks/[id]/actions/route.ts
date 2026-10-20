import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { activeModuleWork, approvals, appModuleTasks, audit, db, lockAppModules, moduleAppOfTask, tasks } from "@wfos/db";
import { canTransition } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";
import { control, publish, q } from "@/lib/server/queue";
import { createTaskOr400 } from "@/lib/server/tasks";
import { startWaitingModuleWork } from "@/lib/server/app-modules";
import { logger } from "@/lib/server/logger";

const schema = z.object({
  action: z.enum(["start", "cancel", "retry", "dry_run", "request_changes", "discard", "accept"]),
  /** request_changes: what the employee should change; resumes the same Claude session and workspace */
  feedback: z.string().trim().min(3).max(10000).optional(),
});

export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const { action, feedback } = await body(req, schema);
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound();
  if (action === "request_changes") {
    if (!t.agentSessionId) throw new HttpError(409, "Only Workspace-mode tasks can be resumed with changes", { code: "task_not_resumable" });
    if (!["AWAITING_APPROVAL", "DONE", "FAILED"].includes(t.status)) throw new HttpError(409, `Cannot request changes on a ${t.status} task`, { code: "task_cannot_rerun", status: t.status });
    if (!feedback) throw new HttpError(400, "Describe the changes you want", { code: "feedback_required" });
    // pending deliveries of the old version can no longer be approved
    const expired = await db.transaction(async (tx) => {
      // a person let the task go on: its sandbox time limit counts from here (sandboxSecondsBase)
      await tx.update(tasks).set({ status: "QUEUED", error: null, completedAt: null, sandboxSecondsBase: sql`${tasks.sandboxSeconds}` }).where(eq(tasks.id, t.id));
      return tx
        .update(approvals)
        .set({ status: "EXPIRED", decidedBy: session.userId, decidedAt: new Date(), executionResult: { ok: false, summary: "Changes were requested instead." } })
        .where(and(eq(approvals.taskId, t.id), eq(approvals.status, "PENDING")))
        .returning({ id: approvals.id });
    });
    for (const x of expired) await publish(session.workspaceId, { type: "approval.updated", approvalId: x.id, status: "EXPIRED" });
    await publish(session.workspaceId, { type: "task.updated", taskId: t.id, status: "QUEUED" });
    await q.task(t.id, session.workspaceId, `The reviewer requested changes:\n${feedback}\nMake the changes in your workspace, run the tests, commit, and propose the push again.`);
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "task.changes_requested", targetType: "task", targetId: t.id, details: { feedback } });
    return { ok: true };
  }
  if (action === "accept") {
    // P4: a person accepts the result of a task that waits for one (review policy "person")
    if (t.status !== "DONE" || t.reviewPolicy !== "person" || t.reviewedAt) throw new HttpError(409, "This task does not wait for a review", { code: "task_not_awaiting_review" });
    await db.update(tasks).set({ reviewedAt: new Date(), reviewedBy: session.userId }).where(eq(tasks.id, t.id));
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "task.accepted", targetType: "task", targetId: t.id });
    await publish(session.workspaceId, { type: "task.updated", taskId: t.id, status: "DONE" });
    return { ok: true };
  }
  if (action === "discard" && t.status === "DONE") {
    // finished work keeps its status; only the workspace files go (deliverables stay on the task)
    await db.update(tasks).set({ workspaceStatus: "discarded" }).where(eq(tasks.id, t.id));
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "task.discarded", targetType: "task", targetId: t.id });
    return { ok: true };
  }
  if (action === "cancel" || action === "discard") {
    if (!canTransition(t.status, "CANCELLED")) throw new HttpError(409, `Cannot cancel a ${t.status} task`, { code: "task_cannot_cancel", status: t.status });
    // a team task takes its open subtasks with it
    const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, t.id));
    const cancelled = [t, ...children.filter((c) => canTransition(c.status, "CANCELLED"))];
    const ids = cancelled.map((c) => c.id);
    const expired = await db.transaction(async (tx) => {
      await tx.update(tasks).set({ status: "CANCELLED", completedAt: new Date(), error: "Cancelled by user" }).where(inArray(tasks.id, ids));
      // pending actions of a cancelled task must never become executable
      return tx
        .update(approvals)
        .set({ status: "EXPIRED", decidedBy: session.userId, decidedAt: new Date(), executionResult: { ok: false, summary: "Task was cancelled before a decision." } })
        .where(and(inArray(approvals.taskId, ids), eq(approvals.status, "PENDING")))
        .returning({ id: approvals.id });
    });
    for (const c of cancelled) {
      await control({ type: "cancel_task", taskId: c.id });
      await publish(session.workspaceId, { type: "task.updated", taskId: c.id, status: "CANCELLED" });
    }
    for (const x of expired) await publish(session.workspaceId, { type: "approval.updated", approvalId: x.id, status: "EXPIRED" });
    // C8: a cancelled module build frees its app: the build that waited starts (the worker never sees a queued task end)
    const moduleApp = await moduleAppOfTask(t.id);
    if (moduleApp) {
      await startWaitingModuleWork(moduleApp.workspaceId, moduleApp.appId).catch((e: unknown) =>
        // the cancel itself is done; the next request also starts when any later module task of the app ends
        logger.warn({ err: (e as Error).message, taskId: t.id }, "waiting module work could not start"),
      );
    }
    // discard: the workspace is removed by the next garbage collection (deliverables stay on the task)
    if (action === "discard") await db.update(tasks).set({ workspaceStatus: "discarded" }).where(eq(tasks.id, t.id));
    await audit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      actorLabel: session.email,
      action: action === "discard" ? "task.discarded" : "task.cancelled",
      targetType: "task",
      targetId: t.id,
      details: { subtasks: ids.length - 1, approvalsExpired: expired.length },
    });
    return { ok: true };
  }
  if (action === "start") {
    if (t.status !== "QUEUED") throw new HttpError(409, "Only queued tasks can be started", { code: "task_not_queued" });
    await db.update(tasks).set({ phase: t.phase === "hold" ? null : t.phase }).where(eq(tasks.id, t.id));
    await q.task(t.id, session.workspaceId);
    return { ok: true };
  }
  if (action === "retry" || action === "dry_run") {
    if (!["FAILED", "CANCELLED", "DONE", "QUEUED"].includes(t.status)) throw new HttpError(409, `Cannot rerun a ${t.status} task`, { code: "task_cannot_rerun", status: t.status });
    if (action === "dry_run" || t.status === "DONE") {
      // reruns of finished work create a fresh copy so history stays intact
      const copy = await createTaskOr400(db, {
        workspaceId: t.workspaceId,
        title: `${action === "dry_run" ? "[DRY RUN] " : ""}${t.title}`,
        brief: t.brief,
        assigneeId: t.assigneeId,
        teamId: t.teamId,
        clientId: t.clientId,
        projectId: t.projectId,
        source: "board",
        dryRun: action === "dry_run" ? true : t.dryRun,
        createdBy: session.userId,
        // a copy of work that started from untrusted input is just as untrusted; originTaskId keeps the lineage
        untrustedInput: t.untrustedInput,
        originTaskId: t.id,
        // unchanged: a copy keeps the original's (possibly since removed) assignee and team
        requireAssignee: false,
        requireTeamLead: false,
      });
      await publish(session.workspaceId, { type: "task.created", taskId: copy.id, title: copy.title, employeeId: copy.assigneeId });
      await q.task(copy.id, session.workspaceId);
      return { taskId: copy.id };
    }
    const busy = await db.transaction(async (tx) => {
      // C8: a module build or change retried in place keeps one build per app (no queue skipping)
      const [link] = await tx.select({ role: appModuleTasks.role }).from(appModuleTasks).where(eq(appModuleTasks.taskId, t.id));
      const moduleApp = link && (link.role === "build" || link.role === "change") ? await moduleAppOfTask(t.id) : null;
      if (moduleApp) {
        await lockAppModules(tx, moduleApp.appId);
        const running = await activeModuleWork(tx, moduleApp.appId);
        if (running && running.taskId !== t.id) return running.title;
      }
      await tx
        .update(tasks)
        .set({ status: "QUEUED", error: null, phase: t.teamId && !t.parentTaskId ? null : t.phase, sandboxSecondsBase: sql`${tasks.sandboxSeconds}` })
        .where(eq(tasks.id, t.id));
      return null;
    });
    if (busy) throw new HttpError(409, "Another module of this app is being built: retry when it is done", { code: "app_module_busy", task: busy });
    await publish(session.workspaceId, { type: "task.updated", taskId: t.id, status: "QUEUED" });
    await q.task(t.id, session.workspaceId);
    return { taskId: t.id };
  }
});
