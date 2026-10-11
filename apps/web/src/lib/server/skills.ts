import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hasControlChars, isReservedSkillSlug, SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX, SKILL_SLUG_MAX, SKILL_SLUG_RE, utf8Bytes } from "@wfos/shared";
import { screenLeakage } from "@wfos/shared/server";
import { parseSkillMarkdown } from "@/lib/skill-md";
import { HttpError } from "./auth";

/** sha256 of what was saved (slug, description and body joined by newlines), hex. */
export function skillProvenanceHash(slug: string, description: string, body: string): string {
  return createHash("sha256").update(`${slug}\n${description}\n${body}`).digest("hex");
}

/** POST /api/skills: the fields, or a whole SKILL.md (frontmatter name + description, markdown body). */
export const createSkillSchema = z.union([
  z.object({ markdown: z.string().min(1).max(SKILL_BODY_MAX * 2) }).strict(),
  z.object({ slug: z.string().trim().min(1).max(200), description: z.string().max(SKILL_DESCRIPTION_MAX * 4), body: z.string().max(SKILL_BODY_MAX * 2) }).strict(),
]);

export const patchSkillSchema = z.object({
  enabled: z.boolean(),
  description: z.string().max(SKILL_DESCRIPTION_MAX * 4),
  body: z.string().max(SKILL_BODY_MAX * 2),
});

export interface SkillInput {
  slug: string;
  description: string;
  body: string;
}

/** The skill to store from a create request; a readable 400 when the SKILL.md cannot be read. */
export function skillFromRequest(input: z.infer<typeof createSkillSchema>): SkillInput & { ignoredFields: string[] } {
  if ("markdown" in input) {
    const r = parseSkillMarkdown(input.markdown);
    if (!r.ok && r.error === "invalid_chars") throw new HttpError(400, "Skills cannot contain control characters", { code: "skill_invalid_chars" });
    if (!r.ok) throw new HttpError(400, `SKILL.md could not be read (${r.error})`, { code: "skill_md_invalid", reason: r.error, line: r.line ?? 0 });
    return { slug: r.name, description: r.description, body: r.body, ignoredFields: r.ignoredFields };
  }
  return { slug: input.slug, description: input.description.trim(), body: input.body.trimEnd(), ignoredFields: [] };
}

/**
 * Check a skill before it is saved: no control characters, a kebab-case slug that is not a built-in skill's name
 * (only on create: the slug never changes), a description, a non-empty body, the size limits, and no secret or
 * personal data (a skill is read back into prompts, so a high finding refuses the save; medium ones are returned as
 * warnings).
 */
export function validateSkill(s: Partial<SkillInput>): { warnings: string[] } {
  // NUL, ESC and the other C0 controls (tab, LF and CR are fine): a skill is written to files and prompts
  const bad = (["slug", "description", "body"] as const).filter((f) => s[f] !== undefined && hasControlChars(s[f]!));
  if (bad.length) throw new HttpError(400, "Skills cannot contain control characters", { code: "skill_invalid_chars", fields: bad.join(", ") });
  if (s.slug !== undefined && (s.slug.length > SKILL_SLUG_MAX || !SKILL_SLUG_RE.test(s.slug))) {
    throw new HttpError(400, "Skill names are kebab-case", { code: "skill_invalid_slug", max: SKILL_SLUG_MAX });
  }
  if (s.slug !== undefined && isReservedSkillSlug(s.slug)) {
    throw new HttpError(400, `${s.slug} is the name of a built-in skill`, { code: "skill_slug_reserved", slug: s.slug });
  }
  if (s.description !== undefined) {
    if (!s.description.trim()) throw new HttpError(400, "A skill needs a description", { code: "skill_description_required" });
    if (s.description.length > SKILL_DESCRIPTION_MAX) throw new HttpError(400, "Description too long", { code: "skill_description_too_long", max: SKILL_DESCRIPTION_MAX });
  }
  if (s.body !== undefined && !s.body.trim()) throw new HttpError(400, "A skill needs instructions", { code: "skill_body_required" });
  // a byte limit, as the worker enforces it (Buffer.byteLength(body, "utf8") <= SKILL_BODY_MAX)
  if (s.body !== undefined && utf8Bytes(s.body) > SKILL_BODY_MAX) throw new HttpError(400, "Skill body too large", { code: "skill_body_too_long", max: SKILL_BODY_MAX, bytes: utf8Bytes(s.body) });
  const findings = [...screenLeakage(s.description ?? ""), ...screenLeakage(s.body ?? "")];
  const high = [...new Set(findings.filter((f) => f.severity === "high").map((f) => f.rule))];
  if (high.length) throw new HttpError(400, "The skill contains secrets", { code: "skill_leak", rules: high.join(", "), ruleList: high });
  return { warnings: [...new Set(findings.map((f) => f.rule))] };
}
