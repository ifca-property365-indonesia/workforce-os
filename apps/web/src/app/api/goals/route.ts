import { and, asc, count, eq, gte, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { audit, db, goals, projects, steps, tasks } from "@wfos/db";
import { TERMINAL_STATUSES } from "@wfos/shared";
import { checkGoalRefs, goalInputSchema } from "@/lib/server/goals";
import { body, route } from "@/lib/server/route";

const DAY = 86_400_000;

/**
 * P1: the workspace's goals with what was done for them: tasks open and done, projects, credits in the last 30 days
 * and in all. Each goal's own numbers and, in `total`, with the goals under it.
 */
export const GET = route("VIEWER", async ({ session }) => {
  const ws = session.workspaceId;
  const rows = await db.select().from(goals).where(eq(goals.workspaceId, ws)).orderBy(asc(goals.position), asc(goals.createdAt));
  const ids = rows.map((g) => g.id);
  const terminal = [...TERMINAL_STATUSES];
  const [taskStats, recent, projectCounts] = ids.length
    ? await Promise.all([
        db
          .select({
            goalId: tasks.goalId,
            open: sql<number>`count(*) filter (where ${tasks.status} not in (${sql.join(terminal.map((s) => sql`${s}`), sql`, `)}))`.mapWith(Number),
            done: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')`.mapWith(Number),
            credits: sum(tasks.costCredits).mapWith(Number),
          })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, ws), inArray(tasks.goalId, ids)))
          .groupBy(tasks.goalId),
        db
          .select({ goalId: tasks.goalId, credits: sum(steps.credits).mapWith(Number) })
          .from(steps)
          .innerJoin(tasks, eq(tasks.id, steps.taskId))
          .where(and(eq(steps.workspaceId, ws), gte(steps.createdAt, new Date(Date.now() - 30 * DAY)), inArray(tasks.goalId, ids)))
          .groupBy(tasks.goalId),
        db.select({ goalId: projects.goalId, n: count() }).from(projects).where(and(eq(projects.workspaceId, ws), isNotNull(projects.goalId))).groupBy(projects.goalId),
      ])
    : [[], [], []];
  const own = new Map(
    rows.map((g) => {
      const t = taskStats.find((x) => x.goalId === g.id);
      return [g.id, { open: t?.open ?? 0, done: t?.done ?? 0, credits: t?.credits ?? 0, credits30d: recent.find((x) => x.goalId === g.id)?.credits ?? 0, projects: projectCounts.find((x) => x.goalId === g.id)?.n ?? 0 }];
    }),
  );
  // a goal's total includes the goals under it (a cycle cannot form: PATCH refuses it)
  const children = new Map<string, string[]>();
  for (const g of rows) if (g.parentId) children.set(g.parentId, [...(children.get(g.parentId) ?? []), g.id]);
  const total = (id: string, seen = new Set<string>()): { open: number; done: number; credits: number; credits30d: number } => {
    seen.add(id);
    const o = own.get(id)!;
    const acc = { open: o.open, done: o.done, credits: o.credits, credits30d: o.credits30d };
    for (const c of children.get(id) ?? [])
      if (!seen.has(c)) {
        const s = total(c, seen);
        acc.open += s.open;
        acc.done += s.done;
        acc.credits += s.credits;
        acc.credits30d += s.credits30d;
      }
    return acc;
  };
  const [unassigned] = await db
    .select({ credits: sum(steps.credits).mapWith(Number) })
    .from(steps)
    .innerJoin(tasks, eq(tasks.id, steps.taskId))
    .where(and(eq(steps.workspaceId, ws), gte(steps.createdAt, new Date(Date.now() - 30 * DAY)), sql`${tasks.goalId} is null`));
  return { goals: rows.map((g) => ({ ...g, stats: own.get(g.id)!, total: total(g.id) })), withoutGoal30d: unassigned?.credits ?? 0 };
});

/** A new goal (Admin). */
export const POST = route("ADMIN", async ({ session, req }) => {
  const i = await body(req, goalInputSchema);
  await checkGoalRefs(session.workspaceId, i);
  const [g] = await db
    .insert(goals)
    .values({ workspaceId: session.workspaceId, title: i.title, description: i.description, parentId: i.parentId, teamId: i.teamId, targetDate: i.targetDate, createdBy: session.userId })
    .returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "goal.created", targetType: "goal", targetId: g!.id, details: { title: g!.title } });
  return { goal: g };
});
