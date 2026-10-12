import { z } from "zod";
// NOTE: index.ts re-exports this module, so values imported from "./index" are not initialised yet while this
// module body runs. Every schema that needs them is therefore built lazily (on first parse), never at load time.
import {
  AUTONOMY_LEVELS,
  egressDomainSchema,
  EXECUTION_MODES,
  officeLookSchema,
  OUTPUT_LANGUAGES,
  SKILL_BODY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_SLUG_RE,
  TEAM_RESPONDER_MODES,
  toolPermissionSchema,
} from "./index";

// ---------------------------------------------------------------------------
// Team / employee packages (wfos.package v1): a portable, secret-free description of employees, teams,
// routines, departments, skills (SKILL.md) and MCP server slots. Never contains allow-lists, credentials, chats, tasks or DB ids.
// ---------------------------------------------------------------------------

export const PACKAGE_FORMAT = "wfos.package";
export const PACKAGE_VERSION = 1;
/** Largest accepted package, serialized as JSON (UTF-8 bytes). */
export const PACKAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PACKAGE_FILE_SUFFIX = ".wfos.json";

/** Keys reference employees / teams / departments inside one package: lowercase slugs. */
export const PACKAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Same rule as the MCP settings route: [a-z0-9-] parts joined by single "_", 2–32 chars. */
export const MCP_SLOT_NAME_RE = /^(?=.{2,32}$)[a-z0-9-]+(?:_[a-z0-9-]+)*$/;
const DEPARTMENT_KEY_RE = /^[a-z0-9_-]{1,40}$/;
/** Longest skill slug (the SKILL.md `name`). */
export const SKILL_SLUG_MAX = 64;
/** Most skills one package carries / one employee lists. */
export const PACKAGE_SKILLS_MAX = 200;
/**
 * Skill slugs that name a skill Claude Code ships with (document skills). A workspace skill must not shadow one:
 * POST /api/skills refuses them and an import renames them (pdf → pdf-2), as the worker installs trusted skills as
 * ~/.claude/skills/wfos-<slug>/.
 */
export const SKILL_RESERVED_SLUGS: readonly string[] = ["pdf", "docx", "xlsx", "pptx"];
export const isReservedSkillSlug = (slug: string): boolean => SKILL_RESERVED_SLUGS.includes(slug);

/** C0 control characters other than tab, line feed and carriage return (NUL, ESC, …): never in a skill. */
const isForbiddenControl = (code: number): boolean => code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isForbiddenControl(text.charCodeAt(i))) return true;
  return false;
}
/** `text` without those control characters (an export never fails on a stored skill that has one). */
export function stripControlChars(text: string): string {
  if (!hasControlChars(text)) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) if (!isForbiddenControl(text.charCodeAt(i))) out += text[i];
  return out;
}

/** What an export never contains (shown in the export report; translated as packages.leftOut.<key>). */
export const PACKAGE_LEFT_OUT = [
  "allowList",
  "credentials",
  "mcpTokens",
  "chats",
  "tasks",
  "approvals",
  "knowledge",
  "clients",
  "budgets",
  "status",
  "toolStates",
  "routineSchedule",
  "ids",
] as const;
export type PackageLeftOut = (typeof PACKAGE_LEFT_OUT)[number];

export type PackageFailure = "not_a_package" | "newer_version" | "too_large" | "invalid";

const NEWER_VERSION_MESSAGE = "This package was made by a newer version of Workforce OS. Update this installation to import it.";

/** UTF-8 length of a string in bytes (skill bodies are limited in bytes, not characters). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes (never splits a character). */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    const b = utf8Bytes(ch);
    if (n + b > maxBytes) break;
    out += ch;
    n += b;
  }
  return out;
}

export function packageByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const key = () => z.string().regex(PACKAGE_KEY_RE, "a lowercase key like sales-lead");
const skillSlug = () => z.string().max(SKILL_SLUG_MAX).regex(SKILL_SLUG_RE, "a kebab-case skill name like weekly-report");
const bilingual = () => z.object({ en: z.string().max(20000), id: z.string().max(20000) });

function buildSchema() {
  const employee = z.object({
    key: key(),
    name: z.string().min(1).max(80),
    // an emoji (older data) or the bot avatar choice, "bot:<shape>/<colour>/<expression>"
    avatar: z.string().max(64).default("🤖"),
    role: z.string().min(1).max(80),
    templateKey: z.string().max(80).nullable().optional(),
    persona: z.string().max(4000).default(""),
    instructions: z.string().max(20000).default(""),
    businessContext: z.string().max(20000).default(""),
    model: z.string().min(1).max(100),
    autonomyLevel: z.enum(AUTONOMY_LEVELS).default("DRAFT"),
    /** tool names / selectors only (built-ins, `mcp:<server>`, `mcp:<server>:<tool or glob>`), no enabled state */
    toolPermissions: z.array(toolPermissionSchema.shape.tool).max(300).default([]),
    outputLanguage: z.enum(OUTPUT_LANGUAGES).default("inherit"),
    executionMode: z.enum(EXECUTION_MODES).default("tool"),
    department: z.string().regex(DEPARTMENT_KEY_RE).nullable().optional(),
    egressDomains: z.array(egressDomainSchema).max(50).default([]),
    look: officeLookSchema.nullable().optional(),
    seedMemories: z
      .array(z.object({ kind: z.enum(["fact", "feedback", "preference"]).default("fact"), content: z.string().min(1).max(4000) }))
      .max(500)
      .optional(),
    /** slugs of the package's skills this employee is assigned */
    skillSlugs: z.array(skillSlug()).max(PACKAGE_SKILLS_MAX).optional(),
  });
  /** a SKILL.md without scripts or resources: its name, description and markdown body */
  const skill = z.object({
    slug: skillSlug(),
    description: z
      .string()
      .min(1)
      .max(SKILL_DESCRIPTION_MAX)
      .refine((d) => !hasControlChars(d), { message: "control characters are not allowed in a skill" }),
    /** SKILL_BODY_MAX is a UTF-8 byte limit (as the worker enforces it) */
    body: z
      .string()
      .max(SKILL_BODY_MAX)
      .refine((b) => utf8Bytes(b) <= SKILL_BODY_MAX, { message: "the skill body is larger than SKILL_BODY_MAX bytes" })
      .refine((b) => !hasControlChars(b), { message: "control characters are not allowed in a skill" }),
  });
  const team = z.object({
    key: key(),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(""),
    leadKey: key().nullable().default(null),
    memberKeys: z.array(key()).max(200).default([]),
    responderMode: z.enum(TEAM_RESPONDER_MODES).default("lead"),
  });
  const routine = z.object({
    name: z.string().min(1).max(120),
    cron: z.string().min(9).max(120),
    timezone: z.string().min(1).max(64).default("Asia/Jakarta"),
    brief: z.string().min(1).max(20000),
    assigneeKey: key().nullable().optional(),
    teamKey: key().nullable().optional(),
    perClient: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  });
  const department = z.object({
    key: z.string().regex(DEPARTMENT_KEY_RE),
    name: bilingual(),
    sop: bilingual(),
    subagents: z
      .array(z.object({ name: z.string().min(1).max(80), description: bilingual(), prompt: bilingual(), tools: z.array(z.string().max(200)).max(100).optional() }))
      .max(50)
      .default([]),
  });
  const mcpSlot = z.object({
    name: z.string().regex(MCP_SLOT_NAME_RE, "an MCP server name like crm"),
    url: z.url({ protocol: /^https?$/ }).max(2000),
  });

  const body = z
    .object({
      format: z.literal(PACKAGE_FORMAT),
      version: z.literal(PACKAGE_VERSION),
      meta: z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
        exportedAt: z.string().max(40),
        appCommit: z.string().max(64).optional(),
      }),
      employees: z.array(employee).max(200).default([]),
      teams: z.array(team).max(100).default([]),
      routines: z.array(routine).max(200).default([]),
      departments: z.array(department).max(50).optional(),
      skills: z.array(skill).max(PACKAGE_SKILLS_MAX).optional(),
      mcpSlots: z.array(mcpSlot).max(50).default([]),
    })
    .superRefine((p, ctx) => {
      const dupes = (items: { k: string; i: number }[], path: string, field: string) => {
        const seen = new Set<string>();
        for (const { k, i } of items) {
          if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path, i, field], message: `duplicate ${field} "${k}"` });
          seen.add(k);
        }
      };
      dupes(p.employees.map((e, i) => ({ k: e.key, i })), "employees", "key");
      dupes(p.teams.map((t, i) => ({ k: t.key, i })), "teams", "key");
      dupes((p.departments ?? []).map((d, i) => ({ k: d.key, i })), "departments", "key");
      dupes(p.mcpSlots.map((s, i) => ({ k: s.name, i })), "mcpSlots", "name");
      dupes((p.skills ?? []).map((s, i) => ({ k: s.slug, i })), "skills", "slug");
      const skills = new Set((p.skills ?? []).map((s) => s.slug));
      p.employees.forEach((e, i) => {
        e.skillSlugs?.forEach((s, j) => {
          if (!skills.has(s)) ctx.addIssue({ code: "custom", path: ["employees", i, "skillSlugs", j], message: `unknown skill "${s}"` });
        });
      });
      const emps = new Set(p.employees.map((e) => e.key));
      const teams = new Set(p.teams.map((t) => t.key));
      p.teams.forEach((t, i) => {
        if (t.leadKey && !emps.has(t.leadKey)) ctx.addIssue({ code: "custom", path: ["teams", i, "leadKey"], message: `unknown employee "${t.leadKey}"` });
        t.memberKeys.forEach((m, j) => {
          if (!emps.has(m)) ctx.addIssue({ code: "custom", path: ["teams", i, "memberKeys", j], message: `unknown employee "${m}"` });
        });
      });
      p.routines.forEach((r, i) => {
        if (!r.assigneeKey && !r.teamKey) ctx.addIssue({ code: "custom", path: ["routines", i], message: "a routine needs an assigneeKey or a teamKey" });
        if (r.assigneeKey && !emps.has(r.assigneeKey)) ctx.addIssue({ code: "custom", path: ["routines", i, "assigneeKey"], message: `unknown employee "${r.assigneeKey}"` });
        if (r.teamKey && !teams.has(r.teamKey)) ctx.addIssue({ code: "custom", path: ["routines", i, "teamKey"], message: `unknown team "${r.teamKey}"` });
      });
    });

  // checked before the body so that a newer or foreign file gets one readable error instead of a field list
  const envelope = z.unknown().superRefine((v, ctx) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || (v as { format?: unknown }).format !== PACKAGE_FORMAT) {
      ctx.addIssue({ code: "custom", message: "This is not a Workforce OS package (format wfos.package).", params: { reason: "not_a_package" } });
      return;
    }
    const version = (v as { version?: unknown }).version;
    if (typeof version === "number" && version > PACKAGE_VERSION) {
      ctx.addIssue({ code: "custom", message: NEWER_VERSION_MESSAGE, params: { reason: "newer_version" } });
      return;
    }
    if (packageByteSize(v) > PACKAGE_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: `The package is larger than ${PACKAGE_MAX_BYTES / 1024 / 1024} MB.`, params: { reason: "too_large" } });
    }
  });
  return envelope.pipe(body);
}

type PackageSchema = ReturnType<typeof buildSchema>;
let built: PackageSchema | null = null;
const schema = (): PackageSchema => (built ??= buildSchema());

/** The wfos.package v1 schema (unknown fields are ignored, cross-references and the 2 MB limit are checked). */
export const wfosPackageSchema = z.lazy(schema);
export type WfosPackage = z.output<PackageSchema>;
export type WfosPackageInput = z.input<PackageSchema["out"]>;
export type PackageEmployee = WfosPackage["employees"][number];
export type PackageTeam = WfosPackage["teams"][number];
export type PackageRoutine = WfosPackage["routines"][number];
export type PackageDepartment = NonNullable<WfosPackage["departments"]>[number];
export type PackageMcpSlot = WfosPackage["mcpSlots"][number];
export type PackageSkill = NonNullable<WfosPackage["skills"]>[number];

export type PackageParseResult =
  | { ok: true; pkg: WfosPackage }
  | { ok: false; reason: PackageFailure; message: string; issues: { path: string; message: string }[] };

/** Validate a package with a readable outcome: why it failed, and at most 20 field issues. */
export function parseWfosPackage(raw: unknown): PackageParseResult {
  const r = schema().safeParse(raw);
  if (r.success) return { ok: true, pkg: r.data };
  const first = r.error.issues[0];
  const reason = ((first as { params?: { reason?: PackageFailure } } | undefined)?.params?.reason ?? "invalid") as PackageFailure;
  const issues = r.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  const message = reason === "invalid" ? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ") : first!.message;
  return { ok: false, reason, message, issues };
}

/** A key derived from a name ("Sales Lead" → sales-lead), made unique against `taken` (which it extends). */
export function packageKey(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "item";
  let k = base;
  for (let i = 2; taken.has(k); i++) k = `${base}-${i}`;
  taken.add(k);
  return k;
}

/** An MCP server name not in `taken`: crm, crm-2, crm-3 … (always a valid server name, at most 32 chars). */
export function uniqueMcpName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const head = base.slice(0, 32 - suffix.length).replace(/_+$/, "");
    const name = `${head}${suffix}`;
    if (!taken.has(name) && MCP_SLOT_NAME_RE.test(name)) return name;
  }
}

/**
 * A skill slug not in `taken` and not reserved (SKILL_RESERVED_SLUGS): weekly-report, weekly-report-2 …, pdf → pdf-2
 * (always a valid slug of at most SKILL_SLUG_MAX chars).
 */
export function uniqueSkillSlug(base: string, taken: Set<string>): string {
  const free = (slug: string) => !taken.has(slug) && !isReservedSkillSlug(slug);
  if (free(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const head = base.slice(0, SKILL_SLUG_MAX - suffix.length).replace(/-+$/, "");
    const slug = `${head}${suffix}`;
    if (free(slug)) return slug;
  }
}

/** The MCP server a tool selector names (`mcp:crm` / `mcp:crm:list_*` → crm), else null. */
export function mcpServerOfSelector(tool: string): string | null {
  if (!tool.startsWith("mcp:")) return null;
  return tool.split(":")[1] || null;
}

/** The selector with its MCP server renamed (`mcp:crm:list_*` with crm → crm-2 gives `mcp:crm-2:list_*`). */
export function renameMcpSelector(tool: string, renames: Map<string, string>): string {
  const server = mcpServerOfSelector(tool);
  const to = server ? renames.get(server) : undefined;
  if (!server || !to) return tool;
  return ["mcp", to, ...tool.split(":").slice(2)].join(":");
}

/** File name for a downloaded package: "Sales Team" → sales-team.wfos.json */
export function packageFileName(name: string): string {
  return `${packageKey(name, new Set())}${PACKAGE_FILE_SUFFIX}`;
}
