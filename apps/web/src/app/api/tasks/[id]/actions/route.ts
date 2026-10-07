import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, tasks } from "@wfos/db";
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
    if (!canTransition(t.status, "CANCELLED")) throw new HttpError(409, `Cannot cancel a ${t.status} task`);
    await db.update(tasks).set({ status: "CANCELLED", completedAt: new Date(), error: "Cancelled by user" }).where(eq(tasks.id, t.id));
    await control({ type: "cancel_task", taskId: t.id });
    await publish(session.workspaceId, { type: "task.updated", taskId: t.id, status: "CANCELLED" });
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "task.cancelled", targetType: "task", targetId: t.id });
    return { ok: true };
  }
  if (action === "start") {
    if (t.status !== "QUEUED") throw new HttpError(409, "Only queued tasks can be started");
    await db.update(tasks).set({ phase: t.phase === "hold" ? null : t.phase }).where(eq(tasks.id, t.id));
    await q.task(t.id, session.workspaceId);
    return { ok: true };
  }
  if (action === "retry" || action === "dry_run") {
    if (!["FAILED", "CANCELLED", "DONE", "QUEUED"].includes(t.status)) throw new HttpError(409, `Cannot rerun a ${t.status} task`);
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
