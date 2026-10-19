import { and, asc, count, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { audit, db, employees, employeeSkills, skills } from "@wfos/db";
import { hasRole } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { createSkillSchema, skillFromRequest, skillProvenanceHash, validateSkill } from "@/lib/server/skills";

/** The workspace's skills, with how many (non-archived) employees have each. The body only for Owners and Admins. */
export const GET = route("VIEWER", async ({ session }) => {
  const admin = hasRole(session.role, "ADMIN");
  const [rows, counts] = await Promise.all([
    // every column but the files (a catalog skill may carry megabytes of scripts and data): their count only
    db
      .select({ ...getTableColumns(skills), files: sql<{ path: string; content: string }[]>`'[]'::jsonb`, fileCount: sql<number>`jsonb_array_length(${skills.files})` })
      .from(skills)
      .where(eq(skills.workspaceId, session.workspaceId))
      .orderBy(asc(skills.slug)),
    db
      .select({ skillId: employeeSkills.skillId, n: count() })
      .from(employeeSkills)
      .innerJoin(employees, eq(employees.id, employeeSkills.employeeId))
      .where(and(eq(employees.workspaceId, session.workspaceId), ne(employees.status, "ARCHIVED")))
      .groupBy(employeeSkills.skillId),
  ]);
  const n = new Map(counts.map((c) => [c.skillId, Number(c.n)]));
  return {
    skills: rows.map((s) => ({
      id: s.id,
      slug: s.slug,
      description: s.description,
      ...(admin ? { body: s.body } : {}),
      bodyChars: s.body.length,
      source: s.source,
      enabled: s.enabled,
      untrusted: s.untrusted,
      // C4: where a catalog skill came from (repository, commit, license) and whether a newer commit is known
      origin: s.origin ? { source: s.origin.source, path: s.origin.path, commit: s.origin.commit, license: s.origin.license ?? s.origin.licenseFile, url: s.origin.url } : null,
      updateAvailable: s.updateAvailable ? s.updateAvailable.commit : null,
      fileCount: Number(s.fileCount),
      employeeCount: n.get(s.id) ?? 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
  };
});

/** Add a skill: { slug, description, body } or { markdown } (a SKILL.md). Refused when it carries secrets. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const input = skillFromRequest(await body(req, createSkillSchema));
  const { warnings } = validateSkill(input);
  const [row] = await db
    .insert(skills)
    .values({
      workspaceId: session.workspaceId,
      slug: input.slug,
      description: input.description,
      body: input.body,
      source: "user",
      enabled: true,
      untrusted: false,
      provenanceHash: skillProvenanceHash(input.slug, input.description, input.body),
      createdBy: session.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new HttpError(409, "A skill with this name exists", { code: "skill_slug_taken", slug: input.slug });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "skill.created",
    targetType: "skill",
    targetId: row.id,
    details: { slug: row.slug, source: row.source, provenanceHash: row.provenanceHash, ...(warnings.length ? { warnings } : {}) },
  });
  return { skill: { id: row.id, slug: row.slug }, warnings, ignoredFields: input.ignoredFields };
});
