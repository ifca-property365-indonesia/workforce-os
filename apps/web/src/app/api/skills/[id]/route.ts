import { and, eq } from "drizzle-orm";
import { audit, db, employees, employeeSkills, skills } from "@wfos/db";
import { hasRole } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { notFound, patchBody, route } from "@/lib/server/route";
import { patchSkillSchema, skillProvenanceHash, validateSkill } from "@/lib/server/skills";

type P = { id: string };

async function load(workspaceId: string, id: string) {
  const [s] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.workspaceId, workspaceId)));
  if (!s) notFound("skill_not_found");
  return s;
}

/**
 * One skill and the employees it is assigned to. The body and the provenance hash only for Owners and Admins (as in
 * the list): Members and Viewers get the metadata.
 */
export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const admin = hasRole(session.role, "ADMIN");
  const s = await load(session.workspaceId, params.id);
  const assigned = await db
    .select({ id: employees.id, name: employees.name, avatar: employees.avatar, status: employees.status })
    .from(employeeSkills)
    .innerJoin(employees, eq(employees.id, employeeSkills.employeeId))
    .where(and(eq(employeeSkills.skillId, s.id), eq(employees.workspaceId, session.workspaceId)))
    .orderBy(employees.name);
  return {
    skill: {
      id: s.id,
      slug: s.slug,
      description: s.description,
      ...(admin ? { body: s.body, provenanceHash: s.provenanceHash } : {}),
      bodyChars: s.body.length,
      source: s.source,
      enabled: s.enabled,
      untrusted: s.untrusted,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      employees: assigned,
    },
  };
});

/**
 * Switch a skill on or off, or edit its description / body (the provenance hash is recomputed). The untrusted mark
 * stays: a person editing an imported or learned skill does not vouch for where it came from.
 */
export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const input = await patchBody(req, patchSkillSchema.partial());
  if (!Object.keys(input).length) throw new HttpError(400, "Nothing to change", { code: "nothing_to_change" });
  const cur = await load(session.workspaceId, params.id);
  const description = input.description !== undefined ? input.description.trim() : cur.description;
  const bodyText = input.body !== undefined ? input.body.trimEnd() : cur.body;
  const { warnings } = validateSkill({ ...(input.description !== undefined ? { description } : {}), ...(input.body !== undefined ? { body: bodyText } : {}) });
  const provenanceHash = skillProvenanceHash(cur.slug, description, bodyText);
  const [next] = await db
    .update(skills)
    .set({ ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), description, body: bodyText, provenanceHash, updatedAt: new Date() })
    .where(and(eq(skills.id, cur.id), eq(skills.workspaceId, session.workspaceId)))
    .returning();
  if (!next) notFound("skill_not_found");
  const changed = [
    ...(input.enabled !== undefined && input.enabled !== cur.enabled ? ["enabled"] : []),
    ...(description !== cur.description ? ["description"] : []),
    ...(bodyText !== cur.body ? ["body"] : []),
  ];
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "skill.updated",
    targetType: "skill",
    targetId: cur.id,
    details: { slug: cur.slug, changed, enabled: next.enabled, provenanceHash: { before: cur.provenanceHash, after: next.provenanceHash }, ...(warnings.length ? { warnings } : {}) },
  });
  return { ok: true, warnings };
});

/** Delete a skill (its assignments go with it). */
export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  const [gone] = await db
    .delete(skills)
    .where(and(eq(skills.id, params.id), eq(skills.workspaceId, session.workspaceId)))
    .returning({ id: skills.id, slug: skills.slug, source: skills.source, provenanceHash: skills.provenanceHash });
  if (!gone) notFound("skill_not_found");
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "skill.deleted",
    targetType: "skill",
    targetId: gone.id,
    details: { slug: gone.slug, source: gone.source, provenanceHash: gone.provenanceHash },
  });
  return { ok: true };
});
