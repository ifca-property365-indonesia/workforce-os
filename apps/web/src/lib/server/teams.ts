import "server-only";
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { db, employees, teamMembers, teams } from "@wfos/db";
import type { MentionMember } from "@/lib/mentions";
import { HttpError } from "./auth";

/** A team's Lead and members must be employees of the session's workspace (400 otherwise). */
export async function assertWorkspaceEmployees(workspaceId: string, ids: (string | null | undefined)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return;
  const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.workspaceId, workspaceId), inArray(employees.id, wanted)));
  if (found.length !== wanted.length) throw new HttpError(400, "Unknown employee", { code: "unknown_employee" });
}

/** A routine's (or task's) team must belong to the session's workspace (400 otherwise). */
export async function assertWorkspaceTeam(workspaceId: string, teamId: string | null | undefined): Promise<void> {
  if (!teamId) return;
  const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, teamId)));
  if (!t) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
}

/**
 * A team's active members (Lead first, then by name), the only people an @mention can address. Shared by the chat
 * messages route and the MCP server's send_message.
 */
export async function teamRoster(workspaceId: string, teamId: string): Promise<MentionMember[]> {
  const [t] = await db.select({ leadId: teams.leadId }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
  if (!t) return [];
  const rows = await db
    .selectDistinct({ id: employees.id, name: employees.name })
    .from(employees)
    .leftJoin(teamMembers, and(eq(teamMembers.employeeId, employees.id), eq(teamMembers.teamId, teamId)))
    .where(
      and(
        eq(employees.workspaceId, workspaceId),
        ne(employees.status, "ARCHIVED"),
        // the Lead counts even when a lead-only edit left them out of team_members
        t.leadId ? or(eq(teamMembers.teamId, teamId), eq(employees.id, t.leadId)) : eq(teamMembers.teamId, teamId),
      ),
    )
    .orderBy(asc(employees.name));
  return [...rows.filter((r) => r.id === t.leadId), ...rows.filter((r) => r.id !== t.leadId)];
}
