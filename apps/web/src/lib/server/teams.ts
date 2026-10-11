import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, employees, teams } from "@wfos/db";
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
