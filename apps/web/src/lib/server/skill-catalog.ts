import "server-only";
import { and, eq } from "drizzle-orm";
import { audit, db, skills, type SkillOrigin } from "@wfos/db";
import { hasLicense, resolveSkill, SkillCatalogError, skillHash, type ResolvedSkill } from "@wfos/shared/skill-catalog";
import { HttpError } from "./auth";
import { notFound } from "./route";
import { skillProvenanceHash } from "./skills";

/**
 * C4: a catalog skill's newer commit (noted daily by the worker) is never applied by itself: an Admin reads what
 * changed and applies exactly the version shown (same commit, same SKILL.md hash), or leaves it.
 */

async function catalogSkill(workspaceId: string, id: string) {
  const [s] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.workspaceId, workspaceId)));
  if (!s) notFound("skill_not_found");
  if (!s.origin) throw new HttpError(400, "This skill does not come from the catalog", { code: "skill_not_from_catalog" });
  return s as typeof s & { origin: SkillOrigin };
}

/** one hash over the files that get installed (path and content), to apply exactly the files that were shown */
const filesHash = (r: ResolvedSkill) =>
  skillHash(
    r.files
      .filter((f) => f.content !== null)
      .map((f) => `${f.path}\n${skillHash(f.content!)}`)
      .sort()
      .join("\n"),
  );

async function resolveOr502(origin: SkillOrigin, commit: string): Promise<ResolvedSkill> {
  try {
    return await resolveSkill(origin.source, origin.skillId, { commit });
  } catch (e) {
    if (e instanceof SkillCatalogError && e.code === "not_found") throw new HttpError(409, "The skill is no longer in its repository at that commit", { code: "skill_update_gone" });
    throw new HttpError(502, "The skill catalog could not be reached", { code: "skill_catalog_unavailable" });
  }
}

/** The installed version and the newer one, side by side (the UI shows the difference). */
export async function skillUpdatePreview(workspaceId: string, id: string) {
  const s = await catalogSkill(workspaceId, id);
  if (!s.updateAvailable) throw new HttpError(409, "No newer version of this skill is known", { code: "skill_no_update" });
  const r = await resolveOr502(s.origin, s.updateAvailable.commit);
  return {
    current: { commit: s.origin.commit, description: s.description, body: s.body, files: s.files.map((f) => f.path), license: s.origin.license ?? s.origin.licenseFile },
    next: {
      commit: r.commit,
      contentHash: r.contentHash,
      filesHash: filesHash(r),
      path: r.path,
      url: r.url,
      description: r.description || r.name,
      body: r.body,
      files: r.files.map((f) => ({ path: f.path, size: f.size, fetched: f.content !== null, content: f.content !== null && f.content.length <= 50_000 ? f.content : null })),
      license: r.license ?? r.licenseFile?.path ?? null,
      sameFolder: r.path === s.origin.path,
    },
  };
}

/** Apply the version the Admin read: fetched again at that commit, it must hash the same and stay in the same folder. */
export async function applySkillUpdate(session: { workspaceId: string; userId: string; email: string }, id: string, want: { commit: string; contentHash: string; filesHash: string }) {
  const s = await catalogSkill(session.workspaceId, id);
  const r = await resolveOr502(s.origin, want.commit);
  if (r.contentHash !== want.contentHash || filesHash(r) !== want.filesHash || r.path !== s.origin.path) throw new HttpError(409, "The skill changed since you read it", { code: "skill_update_changed" });
  if (!hasLicense(r)) throw new HttpError(409, "The new version has no license", { code: "skill_no_license" });
  const description = r.description || r.name;
  const origin: SkillOrigin = { ...s.origin, commit: r.commit, license: r.license, licenseFile: r.licenseFile?.path ?? null, url: r.url, contentHash: r.contentHash };
  const files = r.files.filter((f): f is typeof f & { content: string } => f.content !== null).map((f) => ({ path: f.path, content: f.content }));
  await db
    .update(skills)
    .set({ description, body: r.body, files, origin, updateAvailable: null, originCheckedAt: new Date(), provenanceHash: skillProvenanceHash(s.slug, description, r.body), updatedAt: new Date() })
    .where(eq(skills.id, s.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "skill.updated_from_catalog",
    targetType: "skill",
    targetId: s.id,
    details: { slug: s.slug, source: s.origin.source, from: s.origin.commit, to: r.commit, license: origin.license ?? origin.licenseFile },
  });
  return { ok: true as const, commit: r.commit };
}
