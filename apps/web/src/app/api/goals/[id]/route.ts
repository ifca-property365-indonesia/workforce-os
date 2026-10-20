import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, goals, GOAL_STATUSES } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { notFound, patchBody, route } from "@/lib/server/route";
import { checkGoalRefs, goalInputSchema } from "@/lib/server/goals";

const patchSchema = goalInputSchema.partial().extend({ status: z.enum(GOAL_STATUSES).optional(), position: z.number().int().min(0).max(10_000).optional() });

async function load(workspaceId: string, id: string) {
  const [g] = await db.select().from(goals).where(and(eq(goals.id, id), eq(goals.workspaceId, workspaceId)));
  return g ?? notFound("goal_not_found");
}

/** Change a goal (Admin). A goal cannot move under itself or under one of its own sub-goals. */
export const PATCH = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const g = await load(session.workspaceId, params.id);
  const i = await patchBody(req, patchSchema);
  await checkGoalRefs(session.workspaceId, i);
  if (i.parentId) {
    const all = await db.select({ id: goals.id, parentId: goals.parentId }).from(goals).where(eq(goals.workspaceId, session.workspaceId));
    const parent = new Map(all.map((x) => [x.id, x.parentId]));
    for (let p: string | null | undefined = i.parentId, n = 0; p && n <= all.length; p = parent.get(p), n++)
      if (p === g.id) throw new HttpError(400, "A goal cannot sit under itself or one of its sub-goals", { code: "goal_cycle" });
  }
  const [row] = await db.update(goals).set({ ...i, updatedAt: new Date() }).where(eq(goals.id, g.id)).returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "goal.updated", targetType: "goal", targetId: g.id, details: { title: row!.title, fields: Object.keys(i) } });
  return { goal: row };
});

/** Delete a goal (Admin): its tasks and projects keep their work without a goal; its sub-goals move up to its parent. */
export const DELETE = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const g = await load(session.workspaceId, params.id);
  await db.transaction(async (tx) => {
    await tx.update(goals).set({ parentId: g.parentId }).where(and(eq(goals.parentId, g.id), eq(goals.workspaceId, session.workspaceId)));
    await tx.delete(goals).where(eq(goals.id, g.id));
  });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "goal.deleted", targetType: "goal", targetId: g.id, details: { title: g.title } });
  return { ok: true };
});
