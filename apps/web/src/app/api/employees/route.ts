import { and, desc, eq, gte, sum } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employees, steps, teamMembers, teams } from "@wfos/db";
import { employeeInputSchema, TEAM_MEMBER_ROLES } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { addToDivision, assertCanJoinDivision } from "@/lib/server/teams";
import { requireStepUp } from "@/lib/server/twofactor";

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(employees).where(eq(employees.workspaceId, session.workspaceId)).orderBy(desc(employees.createdAt));
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const [spend, memberships] = await Promise.all([
    db
      .select({ employeeId: steps.employeeId, s: sum(steps.credits) })
      .from(steps)
      .where(and(eq(steps.workspaceId, session.workspaceId), gte(steps.createdAt, day)))
      .groupBy(steps.employeeId),
    db
      .select({ employeeId: teamMembers.employeeId, role: teamMembers.role, id: teams.id, key: teams.key, name: teams.name, color: teams.color, leadId: teams.leadId, codeLeadId: teams.codeLeadId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teams.workspaceId, session.workspaceId)),
  ]);
  const byId = new Map(spend.map((s) => [s.employeeId, Number(s.s ?? 0)]));
  const divisionOf = new Map(
    memberships.map((m) => [
      m.employeeId,
      { id: m.id, key: m.key, name: m.name, color: m.color, role: m.leadId === m.employeeId ? ("head" as const) : m.codeLeadId === m.employeeId ? ("code_lead" as const) : m.role },
    ]),
  );
  return { employees: rows.map((e) => ({ ...e, spentToday: byId.get(e.id) ?? 0, division: divisionOf.get(e.id) ?? null })) };
});

/** a new hire may join a division right away (the hire page); the one-division rule and the structure rules apply */
const hireSchema = employeeInputSchema.extend({
  division: z.object({ teamId: z.string().uuid(), role: z.enum(TEAM_MEMBER_ROLES).default("member") }).nullable().optional(),
});

export const POST = route("ADMIN", async ({ session, req }) => {
  const { division, ...input } = await body(req, hireSchema);
  // giving an employee a shell (even sandboxed) is a sensitive change: fresh password + 2FA
  if (input.executionMode === "workspace") await requireStepUp(session);
  // checked before the hire, so a refused division never leaves an employee behind
  if (division) await assertCanJoinDivision(session.workspaceId, division.teamId, division.role);
  const [e] = await db.insert(employees).values({ ...input, workspaceId: session.workspaceId }).returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "employee.hired",
    targetType: "employee",
    targetId: e!.id,
    details: { name: e!.name, role: e!.role, autonomy: e!.autonomyLevel, tools: e!.toolPermissions, executionMode: e!.executionMode, egressDomains: e!.egressDomains, division: division ?? null },
  });
  if (division) await addToDivision(session, division.teamId, e!.id, division.role);
  return { employee: e };
});
