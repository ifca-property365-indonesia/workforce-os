import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./index";
import { employees, teamMembers, teams } from "./schema";

export type DivisionRow = typeof teams.$inferSelect;

/** The division an employee belongs to (at most one) and their role in it; null when they are in none. */
export async function employeeDivision(employeeId: string): Promise<{ division: DivisionRow; role: "head" | "code_lead" | "member" | "subagent" } | null> {
  const db = getDb();
  const [row] = await db
    .select({ division: teams, memberRole: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.employeeId, employeeId));
  if (!row) return null;
  const role = row.division.leadId === employeeId ? "head" : row.division.codeLeadId === employeeId ? "code_lead" : row.memberRole;
  return { division: row.division, role };
}

/** Active members of a division working as subagents of its code lead, in a stable order. */
export async function divisionSubagents(divisionId: string) {
  const db = getDb();
  return db
    .select({
      id: employees.id,
      name: employees.name,
      role: employees.role,
      specialty: employees.specialty,
      persona: employees.persona,
      instructions: employees.instructions,
      model: employees.model,
      outputLanguage: employees.outputLanguage,
    })
    .from(teamMembers)
    .innerJoin(employees, eq(employees.id, teamMembers.employeeId))
    .where(and(eq(teamMembers.teamId, divisionId), eq(teamMembers.role, "subagent"), eq(employees.status, "ACTIVE")))
    .orderBy(asc(employees.name));
}

/** Divisions of a workspace by id (org chart order). */
export async function workspaceDivisions(workspaceId: string, ids?: string[]) {
  const db = getDb();
  const where = ids?.length ? and(eq(teams.workspaceId, workspaceId), inArray(teams.id, ids)) : eq(teams.workspaceId, workspaceId);
  return db.select().from(teams).where(where).orderBy(asc(teams.sortOrder), asc(teams.name));
}
