import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employees, employeeSkills, skills, withEmployeeRevision } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";

type P = { id: string };

async function check(workspaceId: string, id: string) {
  const [e] = await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId)));
  if (!e) notFound("employee_not_found");
  return e;
}

/** The skills assigned to this employee (only the workspace's own). */
export const GET = route<P>("VIEWER", async ({ session, params }) => {
  await check(session.workspaceId, params.id);
  const rows = await db
    .select({ id: skills.id, slug: skills.slug, description: skills.description, enabled: skills.enabled, untrusted: skills.untrusted, source: skills.source })
    .from(employeeSkills)
    .innerJoin(skills, eq(skills.id, employeeSkills.skillId))
    .where(and(eq(employeeSkills.employeeId, params.id), eq(skills.workspaceId, session.workspaceId)))
    .orderBy(asc(skills.slug));
  return { skills: rows };
});

const schema = z.object({ skillIds: z.array(z.uuid()).max(500) });

/** Replace the employee's skills. Every skill must belong to this workspace. */
export const PUT = route<P>("ADMIN", async ({ session, req, params }) => {
  const e = await check(session.workspaceId, params.id);
  const want = [...new Set((await body(req, schema)).skillIds)];
  const found = want.length ? await db.select({ id: skills.id, slug: skills.slug }).from(skills).where(and(eq(skills.workspaceId, session.workspaceId), inArray(skills.id, want))) : [];
  if (found.length !== want.length) throw new HttpError(400, "Unknown skill", { code: "unknown_skill" });
  const slugOf = new Map(found.map((s) => [s.id, s.slug]));
  const { added, removed } = await withEmployeeRevision(db, e.id, { workspaceId: session.workspaceId, source: "skills", actorUserId: session.userId, actorLabel: session.email }, async (tx) => {
    const cur = await tx
      .select({ id: employeeSkills.skillId, slug: skills.slug })
      .from(employeeSkills)
      .innerJoin(skills, eq(skills.id, employeeSkills.skillId))
      .where(eq(employeeSkills.employeeId, e.id));
    const had = new Set(cur.map((c) => c.id));
    const add = want.filter((id) => !had.has(id));
    const drop = cur.filter((c) => !want.includes(c.id));
    if (drop.length) await tx.delete(employeeSkills).where(and(eq(employeeSkills.employeeId, e.id), inArray(employeeSkills.skillId, drop.map((d) => d.id))));
    if (add.length) await tx.insert(employeeSkills).values(add.map((skillId) => ({ employeeId: e.id, skillId }))).onConflictDoNothing();
    return { added: add.map((id) => slugOf.get(id)!), removed: drop.map((d) => d.slug) };
  });
  if (added.length || removed.length) {
    await audit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      actorLabel: session.email,
      action: "skill.assignments_updated",
      targetType: "employee",
      targetId: e.id,
      details: { employee: e.name, added, removed },
    });
  }
  return { ok: true, added, removed };
});
