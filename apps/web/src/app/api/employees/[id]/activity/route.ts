import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { conversations, db, employees, steps, tasks } from "@wfos/db";
import { STEP_KINDS, type StepKind } from "@wfos/shared";
import { notFound, route } from "@/lib/server/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An employee's recent steps, newest first, with the task / conversation they belong to.
 * ?before=<step id> continues after that step, ?limit=1–100 (default 50), ?kinds=tool,approval narrows the step kinds.
 * `daily` (credits per day, last 7 days) comes with the first page only. Steps this employee took as a subagent in a
 * code lead's run (steps.actor_employee_id) count as theirs; `asSubagentOf` names whose run it was.
 */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params, req }) => {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!e) notFound("employee_not_found");
  const q = req.nextUrl.searchParams;
  const n = Number(q.get("limit"));
  const limit = q.get("limit") && Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 50;
  const before = q.get("before");
  const cursor = before && UUID.test(before) ? before : null;
  const kinds = (q.get("kinds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is StepKind => (STEP_KINDS as readonly string[]).includes(s));
  // the list shows the code lead's run with its subagents' steps in it; a sum counts each step once, for whoever acted
  // (coalesce(actor_employee_id, employee_id), written so the indexes apply)
  const mine = and(or(eq(steps.employeeId, e.id), eq(steps.actorEmployeeId, e.id)), eq(steps.workspaceId, session.workspaceId));
  const actedByMe = and(or(eq(steps.actorEmployeeId, e.id), and(isNull(steps.actorEmployeeId), eq(steps.employeeId, e.id))), eq(steps.workspaceId, session.workspaceId));
  const runner = alias(employees, "runner");
  const rows = await db
    .select({
      step: steps,
      taskTitle: tasks.title,
      conversationTitle: conversations.title,
      runnerName: runner.name,
    })
    .from(steps)
    .leftJoin(runner, and(eq(runner.id, steps.employeeId), eq(runner.workspaceId, session.workspaceId)))
    .leftJoin(tasks, and(eq(tasks.id, steps.taskId), eq(tasks.workspaceId, session.workspaceId)))
    .leftJoin(conversations, and(eq(conversations.id, steps.conversationId), eq(conversations.workspaceId, session.workspaceId)))
    .where(
      and(
        mine,
        kinds.length ? inArray(steps.kind, kinds) : undefined,
        cursor ? sql`(${steps.createdAt}, ${steps.id}) < (select c.created_at, c.id from steps c where c.id = ${cursor} and c.workspace_id = ${session.workspaceId})` : undefined,
      ),
    )
    .orderBy(desc(steps.createdAt), desc(steps.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const recent = page.map((r) => ({
    ...r.step,
    taskTitle: r.taskTitle,
    // a conversation id from another workspace never resolves: drop it rather than link to it
    conversationId: r.conversationTitle !== null ? r.step.conversationId : null,
    conversationTitle: r.conversationTitle,
    // acted inside another employee's run (a subagent of the code lead)
    asSubagentOf: r.step.actorEmployeeId === e.id && r.step.employeeId !== e.id && r.step.employeeId ? { id: r.step.employeeId, name: r.runnerName ?? "" } : null,
  }));
  const nextCursor = rows.length > limit ? page.at(-1)!.step.id : null;
  if (cursor) return { recent, nextCursor };
  const since = new Date(Date.now() - 7 * 86400_000);
  const daily = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${steps.createdAt}), 'YYYY-MM-DD')`, credits: sql<number>`coalesce(sum(${steps.credits}),0)::float` })
    .from(steps)
    .where(and(actedByMe, gte(steps.createdAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return { recent, daily, nextCursor };
});
