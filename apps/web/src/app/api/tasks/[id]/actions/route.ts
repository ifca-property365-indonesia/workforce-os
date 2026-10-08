import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { approvals, audit, db, tasks } from "@wfos/db";
import { canTransition } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";
import { control, publish, q } from "@/lib/server/queue";

const schema = z.object({ action: z.enum(["start", "cancel", "retry", "dry_run"]) });

export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const { action } = await body(req, schema);
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound();
  if (action === "cancel") {
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
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "task.cancelled", targetType: "task", targetId: t.id, details: { subtasks: ids.length - 1, approvalsExpired: expired.length } });
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
      const [copy] = await db
        .insert(tasks)
        .values({
          workspaceId: t.workspaceId,
          title: `${action === "dry_run" ? "[DRY RUN] " : ""}${t.title}`,
          brief: t.brief,
          assigneeId: t.assigneeId,
          teamId: t.teamId,
          clientId: t.clientId,
          projectId: t.projectId,
          source: "board",
          dryRun: action === "dry_run" ? true : t.dryRun,
          status: "QUEUED",
          createdBy: session.userId,
        })
        .returning();
      await publish(session.workspaceId, { type: "task.created", taskId: copy!.id, title: copy!.title, employeeId: copy!.assigneeId });
      await q.task(copy!.id, session.workspaceId);
      return { taskId: copy!.id };
    }
    await db.update(tasks).set({ status: "QUEUED", error: null, phase: t.teamId && !t.parentTaskId ? null : t.phase }).where(eq(tasks.id, t.id));
    await publish(session.workspaceId, { type: "task.updated", taskId: t.id, status: "QUEUED" });
    await q.task(t.id, session.workspaceId);
    return { taskId: t.id };
  }
});
