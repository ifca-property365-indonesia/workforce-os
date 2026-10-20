import { and, eq, inArray } from "drizzle-orm";
import { changedFields, db, employeeRevisionList, employees, skills } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

/**
 * P2: the employee's configuration revisions, newest first, each with the fields it changed against the one before
 * and the skills it had by name (a skill removed since shows as missing).
 */
export const GET = route<{ id: string }>("MEMBER", async ({ session, params }) => {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!e) notFound("employee_not_found");
  const rows = await employeeRevisionList(db, e.id);
  const ids = [...new Set(rows.flatMap((r) => r.config.skillIds))];
  const names = ids.length ? await db.select({ id: skills.id, slug: skills.slug }).from(skills).where(and(eq(skills.workspaceId, session.workspaceId), inArray(skills.id, ids))) : [];
  const slug = new Map(names.map((s) => [s.id, s.slug]));
  return {
    revisions: rows.map((r, i) => {
      const prev = rows[i + 1];
      return {
        id: r.id,
        version: r.version,
        source: r.source,
        actorLabel: r.actorLabel,
        note: r.note,
        restoredVersion: r.restoredVersion,
        createdAt: r.createdAt,
        changed: prev ? changedFields(prev.config, r.config) : [],
        config: { ...r.config, skills: r.config.skillIds.map((id) => slug.get(id) ?? null) },
      };
    }),
  };
});
