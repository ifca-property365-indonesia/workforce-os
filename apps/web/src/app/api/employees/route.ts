import { and, desc, eq, gte, sum } from "drizzle-orm";
import { audit, db, employees, steps } from "@wfos/db";
import { employeeInputSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(employees).where(eq(employees.workspaceId, session.workspaceId)).orderBy(desc(employees.createdAt));
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const spend = await db
    .select({ employeeId: steps.employeeId, s: sum(steps.credits) })
    .from(steps)
    .where(and(eq(steps.workspaceId, session.workspaceId), gte(steps.createdAt, day)))
    .groupBy(steps.employeeId);
  const byId = new Map(spend.map((s) => [s.employeeId, Number(s.s ?? 0)]));
  return { employees: rows.map((e) => ({ ...e, spentToday: byId.get(e.id) ?? 0 })) };
});

export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, employeeInputSchema);
  const [e] = await db.insert(employees).values({ ...input, workspaceId: session.workspaceId }).returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "employee.hired",
    targetType: "employee",
    targetId: e!.id,
    details: { name: e!.name, role: e!.role, autonomy: e!.autonomyLevel, tools: e!.toolPermissions },
  });
  return { employee: e };
});
