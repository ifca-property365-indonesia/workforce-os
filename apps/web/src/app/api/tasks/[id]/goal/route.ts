import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { audit, db, goals, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";

const schema = z.object({ goalId: z.string().uuid().nullable() });

/** P1: set (or clear) the goal a task serves; its subtasks follow. */
export const PUT = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const { goalId } = await body(req, schema);
  const [t] = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound("task_not_found");
  if (goalId) {
    const [g] = await db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.workspaceId, session.workspaceId)));
    if (!g) throw new HttpError(400, "Unknown goal", { code: "unknown_goal" });
  }
  await db
    .update(tasks)
    .set({ goalId })
    .where(and(eq(tasks.workspaceId, session.workspaceId), or(eq(tasks.id, t.id), eq(tasks.parentTaskId, t.id))));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "task.goal_set", targetType: "task", targetId: t.id, details: { goalId } });
  return { ok: true };
});
