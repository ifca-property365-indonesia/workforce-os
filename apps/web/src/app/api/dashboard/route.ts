import { and, count, eq, gte, sql } from "drizzle-orm";
import { approvals, db, employees, steps, tasks, workspaces } from "@wfos/db";
import { route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const ws = session.workspaceId;
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const since8w = new Date(Date.now() - 56 * 86400_000);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const [[delivered], [spendMonth], [wsRow], statusCounts, approvalCounts, weekly, emps, perTask] = await Promise.all([
    db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.status, "DONE"), gte(tasks.completedAt, since30), sql`${tasks.parentTaskId} is null`)),
    db.select({ s: sql<number>`coalesce(sum(${steps.credits}),0)::float` }).from(steps).where(and(eq(steps.workspaceId, ws), gte(steps.createdAt, monthStart))),
    db.select({ monthlyBudget: workspaces.monthlyBudget }).from(workspaces).where(eq(workspaces.id, ws)),
    db.select({ status: tasks.status, n: count() }).from(tasks).where(eq(tasks.workspaceId, ws)).groupBy(tasks.status),
    db.select({ status: approvals.status, n: count() }).from(approvals).where(and(eq(approvals.workspaceId, ws), gte(approvals.createdAt, since30))).groupBy(approvals.status),
    db
      .select({
        week: sql<string>`to_char(date_trunc('week', ${steps.createdAt}), 'YYYY-MM-DD')`,
        employeeId: steps.employeeId,
        credits: sql<number>`coalesce(sum(${steps.credits}),0)::float`,
      })
      .from(steps)
      .where(and(eq(steps.workspaceId, ws), gte(steps.createdAt, since8w)))
      .groupBy(sql`1`, steps.employeeId)
      .orderBy(sql`1`),
    db.select({ id: employees.id, name: employees.name, avatar: employees.avatar, status: employees.status }).from(employees).where(eq(employees.workspaceId, ws)),
    db
      .select({ avg: sql<number>`coalesce(avg(${tasks.costCredits}),0)::float`, n: count() })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.status, "DONE"), gte(tasks.completedAt, since30))),
  ]);

  const decided = approvalCounts.filter((a) => a.status !== "PENDING").reduce((s, a) => s + a.n, 0);
  const rejected = approvalCounts.find((a) => a.status === "REJECTED")?.n ?? 0;
  return {
    delivered30d: delivered?.n ?? 0,
    costPerCompletedTask: perTask[0]?.avg ?? 0,
    spendThisMonth: spendMonth?.s ?? 0,
    monthlyBudget: wsRow?.monthlyBudget ?? 0,
    statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s.n])),
    approvals: {
      pending: approvalCounts.find((a) => a.status === "PENDING")?.n ?? 0,
      decided,
      approvalRate: decided ? (decided - rejected) / decided : null,
      rejectionRate: decided ? rejected / decided : null,
    },
    weeklySpend: weekly,
    employees: emps,
  };
});
