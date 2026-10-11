import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, employees, steps } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!e) notFound("employee_not_found");
  const since = new Date(Date.now() - 7 * 86400_000);
  const mine = and(eq(steps.employeeId, e.id), eq(steps.workspaceId, session.workspaceId));
  const recent = await db.select().from(steps).where(mine).orderBy(desc(steps.createdAt)).limit(50);
  const daily = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${steps.createdAt}), 'YYYY-MM-DD')`, credits: sql<number>`coalesce(sum(${steps.credits}),0)::float` })
    .from(steps)
    .where(and(mine, gte(steps.createdAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return { recent, daily };
});
