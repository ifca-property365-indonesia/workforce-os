import { and, count, desc, eq, gte, inArray, isNotNull, or, sql, sum } from "drizzle-orm";
import { getDb } from "./index";
import { approvals, auditLog, incidents, steps, tasks, type EmployeeMetrics } from "./schema";

/**
 * C2: one employee's work over the last `days`, from the platform's own records (exact, not estimated): tasks by
 * outcome, incidents, approvals (rejected / edited by a person), changes requested, credits of every step it ran or
 * acted in (as a subagent too), and active minutes (gaps between its steps up to ACTIVE_GAP_MIN count as work).
 */
export const ACTIVE_GAP_MIN = 15;

export async function employeeMetrics(workspaceId: string, employeeId: string, days = 30): Promise<EmployeeMetrics> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const mine = and(eq(steps.workspaceId, workspaceId), or(eq(steps.employeeId, employeeId), eq(steps.actorEmployeeId, employeeId)), gte(steps.createdAt, since));

  const [taskRows, incidentRows, approvalRows, changeRows, creditRow, activeRow, costly] = await Promise.all([
    db
      .select({ status: tasks.status, n: count() })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.assigneeId, employeeId), isNotNull(tasks.completedAt), gte(tasks.completedAt, since), inArray(tasks.status, ["DONE", "FAILED", "CANCELLED"])))
      .groupBy(tasks.status),
    db
      .select({ kind: incidents.kind, n: count() })
      .from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.employeeId, employeeId), gte(incidents.createdAt, since)))
      .groupBy(incidents.kind),
    db
      .select({ status: approvals.status, edited: sql<boolean>`${approvals.editedPayload} is not null`, n: count() })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.employeeId, employeeId), gte(approvals.createdAt, since)))
      .groupBy(approvals.status, sql`${approvals.editedPayload} is not null`),
    db
      .select({ n: count() })
      .from(auditLog)
      .innerJoin(tasks, sql`${tasks.id}::text = ${auditLog.targetId}`)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, "task.changes_requested"), eq(tasks.assigneeId, employeeId), gte(auditLog.createdAt, since))),
    db.select({ c: sum(steps.credits) }).from(steps).where(mine),
    db.execute<{ minutes: string | number | null }>(sql`
      select coalesce(sum(least(extract(epoch from (created_at - prev)) / 60, ${ACTIVE_GAP_MIN})), 0) as minutes
      from (
        select ${steps.createdAt} as created_at, lag(${steps.createdAt}) over (order by ${steps.createdAt}) as prev
        from ${steps}
        where ${mine}
      ) s
      where prev is not null`),
    db
      .select({ id: tasks.id, title: tasks.title, credits: sum(steps.credits) })
      .from(steps)
      .innerJoin(tasks, eq(tasks.id, steps.taskId))
      .where(mine)
      .groupBy(tasks.id, tasks.title)
      .orderBy(desc(sum(steps.credits)))
      .limit(3),
  ]);

  const byStatus = Object.fromEntries(taskRows.map((r) => [r.status, Number(r.n)]));
  const done = byStatus.DONE ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const cancelled = byStatus.CANCELLED ?? 0;
  const byKind = Object.fromEntries(incidentRows.map((r) => [r.kind, Number(r.n)]));
  const ap = { requested: 0, executed: 0, rejected: 0, edited: 0, expired: 0 };
  for (const r of approvalRows) {
    const n = Number(r.n);
    ap.requested += n;
    if (r.status === "EXECUTED") ap.executed += n;
    if (r.status === "REJECTED") ap.rejected += n;
    if (r.status === "EXPIRED") ap.expired += n;
    if (r.edited) ap.edited += n;
  }
  const rows = (activeRow as unknown as { rows?: { minutes: unknown }[] }).rows ?? (activeRow as unknown as { minutes: unknown }[]);
  const minutes = Number((rows as { minutes: unknown }[])[0]?.minutes ?? 0);
  return {
    days,
    tasks: { done, failed, cancelled, total: done + failed + cancelled },
    successRate: done + failed ? Math.round((done / (done + failed)) * 1000) / 1000 : null,
    incidents: { total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind },
    approvals: ap,
    changesRequested: Number(changeRows[0]?.n ?? 0),
    credits: Math.round(Number(creditRow[0]?.c ?? 0) * 100) / 100,
    activeMinutes: Math.round(minutes),
    costliestTasks: costly.map((c) => ({ id: c.id, title: c.title, credits: Math.round(Number(c.credits ?? 0) * 100) / 100 })),
  };
}

/**
 * The platform's score, 1 to 5, from the metrics alone (transparent: the HR employee and people see why). Starts at
 * 5 and loses points for failures, incidents, rejected or edited approvals and changes requested. null below
 * MIN_TASKS finished tasks: too little work to judge.
 */
export const MIN_TASKS_FOR_SCORE = 3;
export function metricScore(m: EmployeeMetrics): number | null {
  const finished = m.tasks.done + m.tasks.failed;
  if (finished < MIN_TASKS_FOR_SCORE) return null;
  let s = 5;
  const success = m.successRate ?? 1;
  if (success < 0.7) s -= 2;
  else if (success < 0.9) s -= 1;
  if (m.incidents.total / finished > 0.2) s -= 1;
  const decided = m.approvals.executed + m.approvals.rejected;
  if (decided >= 3 && m.approvals.rejected / decided > 0.2) s -= 1;
  if (decided >= 3 && m.approvals.edited / decided > 0.3) s -= 0.5;
  if (m.changesRequested / finished > 0.3) s -= 0.5;
  return Math.max(1, Math.min(5, Math.round(s)));
}
