import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, steps } from "@wfos/db";
import { route } from "@/lib/server/route";

export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const since = new Date(Date.now() - 7 * 86400_000);
  const recent = await db
    .select()
    .from(steps)
    .where(and(eq(steps.employeeId, params.id), eq(steps.workspaceId, session.workspaceId)))
    .orderBy(desc(steps.createdAt))
    .limit(50);
  const daily = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${steps.createdAt}), 'YYYY-MM-DD')`, credits: sql<number>`coalesce(sum(${steps.credits}),0)::float` })
    .from(steps)
    .where(and(eq(steps.employeeId, params.id), gte(steps.createdAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return { recent, daily };
});
