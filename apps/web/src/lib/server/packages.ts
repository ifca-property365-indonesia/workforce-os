import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { credentials, db, employees, employeeSkills, memories, routines, skills, teamMembers, teams, workspaces, type DB } from "@wfos/db";
import {
  isTimeZone,
  mcpServerOfSelector,
  packageKey,
  parseWfosPackage,
  PACKAGE_LEFT_OUT,
  PACKAGE_MAX_BYTES,
  PACKAGE_VERSION,
  renameMcpSelector,
  isReservedSkillSlug,
  SKILL_BODY_MAX,
  SKILL_DESCRIPTION_MAX,
  stripControlChars,
  toolPermissionSchema,
  truncateUtf8,
  uniqueMcpName,
  uniqueSkillSlug,
  type PackageEmployee,
  type PackageMcpSlot,
  type PackageRoutine,
  type PackageSkill,
  type PackageTeam,
  type WfosPackage,
} from "@wfos/shared";
import { exportRedact, redactUrl, screenLeakage } from "@wfos/shared/server";
import { assertPublicUrl, type Resolver } from "@wfos/shared/netguard";
import { HttpError } from "./auth";
import { readBodyCapped } from "./body-cap";
import { MCP_RESERVED_NAMES } from "./mcp";
import { skillProvenanceHash } from "./skills";

type Q = Pick<DB, "select">;

/** a division key (teamInputSchema.key) */
const DIVISION_KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;

// ---------------------------------------------------------------------------
// Reading a package from a request
// ---------------------------------------------------------------------------

/**
 * Raw bodies may be pretty-printed; the 2 MB limit applies to the compact package (checked by the schema). The raw
 * body is cut off at 4 MB while it streams in: a larger one is refused without being buffered first.
 */
export const MAX_RAW_BODY = PACKAGE_MAX_BYTES * 2;

/** The request body as a validated package; a readable 4xx otherwise. */
export async function readPackage(req: NextRequest): Promise<WfosPackage> {
  const bytes = await readBodyCapped(req, MAX_RAW_BODY);
  if (!bytes) throw new HttpError(413, "The package is larger than 2 MB", { code: "package_too_large" });
  const text = new TextDecoder("utf-8").decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body", { code: "invalid_json" });
  }
  return parsePackageOrThrow(raw);
}

export function parsePackageOrThrow(raw: unknown): WfosPackage {
  const r = parseWfosPackage(raw);
  if (r.ok) return r.pkg;
  const extra = { issues: r.issues };
  switch (r.reason) {
    case "not_a_package":
      throw new HttpError(400, r.message, { code: "package_not_a_package", ...extra });
    case "newer_version":
      throw new HttpError(400, r.message, { code: "package_newer_version", ...extra });
    case "too_large":
      throw new HttpError(413, r.message, { code: "package_too_large", ...extra });
    default:
      throw new HttpError(400, r.message, { code: "package_invalid", detail: r.message.slice(0, 500), ...extra });
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const exportRequestSchema = z.object({
  employeeIds: z.array(z.uuid()).max(500).optional(),
  teamIds: z.array(z.uuid()).max(200).optional(),
  includeMemories: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  name: z.string().trim().min(1).max(120).optional(),
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export interface PackageRedaction {
  /** e.g. employee:dewi.persona, mcp:crm.url */
  where: string;
  rule: string;
}

export interface ExportReport {
  included: { employees: string[]; teams: string[]; routines: string[]; skills: string[]; mcpSlots: string[] };
  redactions: PackageRedaction[];
  leftOut: string[];
  counts: { employees: number; teams: number; routines: number; skills: number; mcpSlots: number; memories: number; redactions: number };
}

const MEMORIES_PER_EMPLOYEE = 200;

/**
 * Build a secret-free package from the workspace's selection. Selecting a division (team) includes its (non-archived)
 * members; a division carries its head, code lead, subagents, SOP, colour and parallel runs.
 */
export async function buildExport(workspaceId: string, input: ExportRequest): Promise<{ pkg: WfosPackage; report: ExportReport }> {
  const wantEmployees = [...new Set(input.employeeIds ?? [])];
  const wantTeams = [...new Set(input.teamIds ?? [])];
  const everything = !wantEmployees.length && !wantTeams.length;

  const teamRows = everything
    ? await db.select().from(teams).where(eq(teams.workspaceId, workspaceId)).orderBy(teams.createdAt)
    : wantTeams.length
      ? await db.select().from(teams).where(and(eq(teams.workspaceId, workspaceId), inArray(teams.id, wantTeams))).orderBy(teams.createdAt)
      : [];
  if (teamRows.length !== wantTeams.length && !everything) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
  const teamIds = teamRows.map((t) => t.id);
  const memberRows = teamIds.length ? await db.select().from(teamMembers).where(inArray(teamMembers.teamId, teamIds)) : [];

  let empRows: (typeof employees.$inferSelect)[];
  if (everything) {
    empRows = (await db.select().from(employees).where(eq(employees.workspaceId, workspaceId)).orderBy(employees.createdAt)).filter((e) => e.status !== "ARCHIVED");
  } else {
    if (wantEmployees.length) {
      const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.workspaceId, workspaceId), inArray(employees.id, wantEmployees)));
      if (found.length !== wantEmployees.length) throw new HttpError(400, "Unknown employee", { code: "unknown_employee" });
    }
    const fromTeams = [...memberRows.map((m) => m.employeeId), ...teamRows.map((t) => t.leadId).filter((x): x is string => !!x)];
    const ids = [...new Set([...wantEmployees, ...fromTeams])];
    const rows = ids.length ? await db.select().from(employees).where(and(eq(employees.workspaceId, workspaceId), inArray(employees.id, ids))).orderBy(employees.createdAt) : [];
    // a team's archived members stay behind; an archived employee picked explicitly is exported
    empRows = rows.filter((e) => e.status !== "ARCHIVED" || wantEmployees.includes(e.id));
  }

  const redactions: PackageRedaction[] = [];
  const clean = (where: string, text: string, max: number): string => {
    const r = exportRedact(text);
    for (const rule of r.rules) redactions.push({ where, rule });
    return r.text.slice(0, max);
  };

  const empKeys = new Map<string, string>();
  const takenEmp = new Set<string>();
  for (const e of empRows) empKeys.set(e.id, packageKey(e.name, takenEmp));

  let memRows: { employeeId: string; kind: string; content: string }[] = [];
  if (input.includeMemories && empRows.length) {
    const all = await db
      .select({ employeeId: memories.employeeId, kind: memories.kind, content: memories.content })
      .from(memories)
      .where(and(eq(memories.workspaceId, workspaceId), inArray(memories.employeeId, empRows.map((e) => e.id))))
      .orderBy(desc(memories.createdAt));
    const per = new Map<string, number>();
    memRows = all.filter((m) => {
      const n = (per.get(m.employeeId) ?? 0) + 1;
      per.set(m.employeeId, n);
      return n <= MEMORIES_PER_EMPLOYEE;
    });
  }

  // the (enabled) skills assigned to the exported employees: a switched-off skill is not part of how they work
  const skillRows = empRows.length
    ? await db
        .select({ employeeId: employeeSkills.employeeId, slug: skills.slug, description: skills.description, body: skills.body })
        .from(employeeSkills)
        .innerJoin(skills, eq(skills.id, employeeSkills.skillId))
        .where(and(eq(skills.workspaceId, workspaceId), eq(skills.enabled, true), inArray(employeeSkills.employeeId, empRows.map((e) => e.id))))
        .orderBy(skills.slug)
    : [];
  const pkgSkills: PackageSkill[] = [];
  const skillSlugsOf = new Map<string, string[]>();
  for (const r of skillRows) {
    if (!pkgSkills.some((s) => s.slug === r.slug)) {
      pkgSkills.push({
        slug: r.slug,
        // control characters are refused on save; one stored before that must not make the export invalid
        description: clean(`skill:${r.slug}.description`, stripControlChars(r.description), SKILL_DESCRIPTION_MAX) || "-",
        body: truncateUtf8(clean(`skill:${r.slug}.body`, stripControlChars(r.body), SKILL_BODY_MAX), SKILL_BODY_MAX),
      });
    }
    skillSlugsOf.set(r.employeeId, [...(skillSlugsOf.get(r.employeeId) ?? []), r.slug]);
  }

  const mcpNames = new Set<string>();
  const pkgEmployees: PackageEmployee[] = empRows.map((e) => {
    const k = empKeys.get(e.id)!;
    const tools = [...new Set(e.toolPermissions.map((p) => p.tool))].filter((t) => toolPermissionSchema.shape.tool.safeParse(t).success);
    for (const t of tools) {
      const s = mcpServerOfSelector(t);
      if (s) mcpNames.add(s);
    }
    const seeds = memRows
      .filter((m) => m.employeeId === e.id)
      .map((m, i) => ({ kind: (["fact", "feedback", "preference"].includes(m.kind) ? m.kind : "fact") as "fact" | "feedback" | "preference", content: clean(`employee:${k}.memories.${i}`, m.content, 4000) }))
      .filter((m) => m.content.trim());
    return {
      key: k,
      name: clean(`employee:${k}.name`, e.name, 80),
      avatar: e.avatar,
      role: clean(`employee:${k}.role`, e.role, 80),
      templateKey: e.templateKey,
      persona: clean(`employee:${k}.persona`, e.persona, 4000),
      instructions: clean(`employee:${k}.instructions`, e.instructions, 20000),
      businessContext: clean(`employee:${k}.businessContext`, e.businessContext, 20000),
      model: e.model,
      autonomyLevel: e.autonomyLevel,
      toolPermissions: tools,
      outputLanguage: e.outputLanguage,
      executionMode: e.executionMode,
      specialty: clean(`employee:${k}.specialty`, e.specialty, 200),
      egressDomains: e.egressDomains,
      look: e.look ?? null,
      ...(input.includeMemories ? { seedMemories: seeds } : {}),
      ...(skillSlugsOf.has(e.id) ? { skillSlugs: skillSlugsOf.get(e.id)! } : {}),
    };
  });

  const teamKeys = new Map<string, string>();
  const takenTeam = new Set<string>();
  const pkgTeams: PackageTeam[] = teamRows.map((t) => {
    const k = packageKey(t.name, takenTeam);
    teamKeys.set(t.id, k);
    const mine = memberRows.filter((m) => m.teamId === t.id);
    const keyOf = (id: string | null) => (id && empKeys.get(id)) || null;
    const codeLeadKey = keyOf(t.codeLeadId);
    // subagents work for the code lead: without one in the package (archived, left out) they travel as members
    const subagentIds = codeLeadKey ? mine.filter((m) => m.role === "subagent" && m.employeeId !== t.leadId && m.employeeId !== t.codeLeadId).map((m) => m.employeeId) : [];
    const memberIds = [...new Set([...(t.leadId ? [t.leadId] : []), ...(t.codeLeadId ? [t.codeLeadId] : []), ...mine.map((m) => m.employeeId)])].filter((id) => !subagentIds.includes(id));
    return {
      key: k,
      name: clean(`team:${k}.name`, t.name, 120),
      description: clean(`team:${k}.description`, t.description, 2000),
      leadKey: keyOf(t.leadId),
      memberKeys: memberIds.map(keyOf).filter((x): x is string => !!x),
      codeLeadKey,
      subagentKeys: subagentIds.map(keyOf).filter((x): x is string => !!x),
      sop: { en: clean(`team:${k}.sop.en`, t.sop.en, 20000), id: clean(`team:${k}.sop.id`, t.sop.id, 20000) },
      color: t.color,
      maxParallel: t.maxParallel,
      responderMode: t.responderMode,
    };
  });

  const empIds = empRows.map((e) => e.id);
  const routineRows = empIds.length || teamIds.length ? (await db.select().from(routines).where(eq(routines.workspaceId, workspaceId)).orderBy(routines.createdAt)).filter((r) => (r.assigneeId && empKeys.has(r.assigneeId)) || (r.teamId && teamKeys.has(r.teamId))) : [];
  const pkgRoutines: PackageRoutine[] = routineRows.map((r, i) => ({
    name: clean(`routine:${i}.name`, r.name, 120),
    cron: r.cron,
    timezone: r.timezone,
    brief: clean(`routine:${i}.brief`, r.brief, 20000) || "-",
    assigneeKey: (r.assigneeId && empKeys.get(r.assigneeId)) || null,
    teamKey: (r.teamId && teamKeys.get(r.teamId)) || null,
    perClient: r.perClient,
    dryRun: r.dryRun,
  }));

  const mcpSlots: PackageMcpSlot[] = [];
  if (mcpNames.size) {
    const rows = await db
      .select({ name: credentials.name, config: credentials.config })
      .from(credentials)
      .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "mcp"), inArray(credentials.name, [...mcpNames])))
      .orderBy(credentials.name);
    for (const r of rows) {
      const found: string[] = [];
      const url = redactUrl(String((r.config as { url?: unknown }).url ?? ""), found);
      for (const rule of found) redactions.push({ where: `mcp:${r.name}.url`, rule });
      if (url) mcpSlots.push({ name: r.name, url });
    }
  }

  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const defaultName = input.name ?? (teamRows.length === 1 && !wantEmployees.length ? teamRows[0]!.name : empRows.length === 1 && !teamRows.length ? empRows[0]!.name : (ws?.name ?? "Workforce"));
  const commit = process.env.WFOS_COMMIT?.trim().slice(0, 64);
  const draft = {
    format: "wfos.package" as const,
    version: PACKAGE_VERSION as 1,
    meta: { name: clean("meta.name", defaultName, 120) || "Workforce", exportedAt: new Date().toISOString(), ...(commit ? { appCommit: commit } : {}) },
    employees: pkgEmployees,
    teams: pkgTeams,
    routines: pkgRoutines,
    ...(pkgSkills.length ? { skills: pkgSkills } : {}),
    mcpSlots,
  };
  // what we hand out must be exactly what an import accepts
  const pkg = parsePackageOrThrow(draft);

  const leftOut: string[] = [...PACKAGE_LEFT_OUT];
  if (!input.includeMemories) leftOut.push("memories");
  const report: ExportReport = {
    included: {
      employees: pkg.employees.map((e) => e.name),
      teams: pkg.teams.map((t) => t.name),
      routines: pkg.routines.map((r) => r.name),
      skills: (pkg.skills ?? []).map((s) => s.slug),
      mcpSlots: pkg.mcpSlots.map((s) => s.name),
    },
    redactions,
    leftOut,
    counts: {
      employees: pkg.employees.length,
      teams: pkg.teams.length,
      routines: pkg.routines.length,
      skills: pkg.skills?.length ?? 0,
      mcpSlots: pkg.mcpSlots.length,
      memories: pkg.employees.reduce((n, e) => n + (e.seedMemories?.length ?? 0), 0),
      redactions: redactions.length,
    },
  };
  return { pkg, report };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportWarning = { code: string } & Record<string, string | number>;
export interface ImportConflict {
  kind: "employee" | "team" | "routine" | "mcpSlot" | "skill";
  name: string;
  /** the name it will be created under, when it differs */
  as?: string;
}

interface Existing {
  employeeNames: Set<string>;
  teamNames: Set<string>;
  routineNames: Set<string>;
  /** division keys already used here (a package division keeps its key only when it is free) */
  teamKeys: Set<string>;
  mcpNames: Set<string>;
  skillSlugs: Set<string>;
}

async function loadExisting(q: Q, workspaceId: string): Promise<Existing> {
  const lower = (xs: { name: string }[]) => new Set(xs.map((x) => x.name.trim().toLowerCase()));
  const [emps, ts, rs, ms, ss] = await Promise.all([
    q.select({ name: employees.name, status: employees.status }).from(employees).where(eq(employees.workspaceId, workspaceId)),
    q.select({ name: teams.name, key: teams.key }).from(teams).where(eq(teams.workspaceId, workspaceId)),
    q.select({ name: routines.name }).from(routines).where(eq(routines.workspaceId, workspaceId)),
    q.select({ name: credentials.name }).from(credentials).where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "mcp"))),
    q.select({ slug: skills.slug }).from(skills).where(eq(skills.workspaceId, workspaceId)),
  ]);
  return {
    employeeNames: lower(emps.filter((e) => e.status !== "ARCHIVED")),
    teamNames: lower(ts),
    routineNames: lower(rs),
    teamKeys: new Set(ts.map((t) => t.key).filter((k): k is string => !!k)),
    mcpNames: new Set(ms.map((m) => m.name)),
    skillSlugs: new Set(ss.map((s) => s.slug)),
  };
}

interface Plan {
  mcpRenames: Map<string, string>;
  /** package skill slug → the slug it is created under (a clash gets -2, -3 …) */
  skillRenames: Map<string, string>;
  /** package division key → the members it is created with (one division per employee: a later duplicate is skipped) */
  divisions: Map<string, { key: string | null; leadKey: string | null; members: { key: string; role: "member" | "subagent" }[] }>;
  warnings: ImportWarning[];
  conflicts: ImportConflict[];
}

function plan(pkg: WfosPackage, ex: Existing): Plan {
  const warnings: ImportWarning[] = [];
  const conflicts: ImportConflict[] = [];
  const has = (set: Set<string>, name: string) => set.has(name.trim().toLowerCase());

  for (const e of pkg.employees) if (has(ex.employeeNames, e.name)) conflicts.push({ kind: "employee", name: e.name });
  for (const t of pkg.teams) if (has(ex.teamNames, t.name)) conflicts.push({ kind: "team", name: t.name });
  for (const r of pkg.routines) if (has(ex.routineNames, r.name)) conflicts.push({ kind: "routine", name: r.name });

  const mcpRenames = new Map<string, string>();
  // a reserved name (oauth, tools) is renamed like a clash: the Settings API could not address it
  const taken = new Set([...ex.mcpNames, ...MCP_RESERVED_NAMES]);
  for (const s of pkg.mcpSlots) {
    const name = uniqueMcpName(s.name, taken);
    taken.add(name);
    mcpRenames.set(s.name, name);
    if (name !== s.name) {
      conflicts.push({ kind: "mcpSlot", name: s.name, as: name });
      warnings.push({ code: "mcp_renamed", from: s.name, to: name });
    }
  }

  const skillRenames = new Map<string, string>();
  const takenSlugs = new Set(ex.skillSlugs);
  for (const s of pkg.skills ?? []) {
    const slug = uniqueSkillSlug(s.slug, takenSlugs);
    takenSlugs.add(slug);
    skillRenames.set(s.slug, slug);
    if (slug !== s.slug) {
      conflicts.push({ kind: "skill", name: s.slug, as: slug });
      // pdf, docx, xlsx and pptx name Claude Code's own document skills: never shadowed
      warnings.push({ code: !ex.skillSlugs.has(s.slug) && isReservedSkillSlug(s.slug) ? "skill_reserved_renamed" : "skill_renamed", from: s.slug, to: slug });
    }
  }
  for (const f of skillLeaks(pkg)) warnings.push({ code: "skill_leak_findings", slug: f.slug, rules: f.rules.join(", ") });
  if (pkg.skills?.length) warnings.push({ code: "skills_untrusted", count: pkg.skills.length });

  // departments are gone (the SOP lives on the division): a package made before divisions still imports without them
  const legacyDepartments = (pkg.departments?.length ?? 0) + pkg.employees.filter((e) => e.department).length;
  if (legacyDepartments) warnings.push({ code: "departments_ignored", count: legacyDepartments });

  // one division per employee: the schema refuses an employee listed in two divisions; an older package's head who
  // is not among the members and already belongs to another division is left out of this one (with a note)
  const divisions: Plan["divisions"] = new Map();
  const placed = new Map<string, string>();
  const nameOf = (k: string) => pkg.employees.find((e) => e.key === k)?.name ?? k;
  for (const t of pkg.teams) for (const k of [...t.memberKeys, ...t.subagentKeys]) placed.set(k, t.name);
  const takenKeys = new Set(ex.teamKeys);
  for (const t of pkg.teams) {
    const members: { key: string; role: "member" | "subagent" }[] = [
      ...t.memberKeys.map((key) => ({ key, role: "member" as const })),
      ...t.subagentKeys.filter((k) => !t.memberKeys.includes(k)).map((key) => ({ key, role: "subagent" as const })),
    ];
    let leadKey = t.leadKey;
    // a head works as a member: one listed only as a subagent is not made head
    if (leadKey && members.some((m) => m.key === leadKey && m.role === "subagent")) {
      warnings.push({ code: "division_head_skipped", name: nameOf(leadKey), division: t.name, other: t.name });
      leadKey = null;
    }
    if (leadKey && !members.some((m) => m.key === leadKey)) {
      const other = placed.get(leadKey);
      if (other && other !== t.name) {
        warnings.push({ code: "division_head_skipped", name: nameOf(leadKey), division: t.name, other });
        leadKey = null;
      } else {
        members.unshift({ key: leadKey, role: "member" });
        placed.set(leadKey, t.name);
      }
    }
    // a division keeps its package key when it is a valid, free division key here
    const key = DIVISION_KEY_RE.test(t.key) && !takenKeys.has(t.key) ? t.key : null;
    if (!key && DIVISION_KEY_RE.test(t.key)) warnings.push({ code: "division_key_taken", name: t.name, key: t.key });
    if (key) takenKeys.add(key);
    divisions.set(t.key, { key, leadKey, members });
  }

  if (pkg.employees.length) warnings.push({ code: "employees_draft", count: pkg.employees.length });
  const toolCount = pkg.employees.reduce((n, e) => n + e.toolPermissions.length, 0);
  if (toolCount) warnings.push({ code: "tools_disabled", count: toolCount });
  for (const e of pkg.employees) if (e.executionMode === "workspace") warnings.push({ code: "workspace_mode", name: e.name });
  if (pkg.routines.length) warnings.push({ code: "routines_disabled", count: pkg.routines.length });
  if (pkg.mcpSlots.length) warnings.push({ code: "mcp_disabled", count: pkg.mcpSlots.length });
  const slots = new Set(pkg.mcpSlots.map((s) => s.name));
  const unknown = new Set<string>();
  for (const e of pkg.employees) {
    for (const t of e.toolPermissions) {
      const s = mcpServerOfSelector(t);
      if (s && !slots.has(s) && !ex.mcpNames.has(s)) unknown.add(s);
    }
  }
  for (const server of unknown) warnings.push({ code: "mcp_unknown", server });
  return { mcpRenames, skillRenames, divisions, warnings, conflicts };
}

/**
 * What the leak screen finds in each package skill (description and body), as on a save in Settings: skills are read
 * back into prompts. A high finding (a key, a password) refuses the import; the others are shown as warnings.
 */
export function skillLeaks(pkg: WfosPackage): { slug: string; rules: string[]; high: string[] }[] {
  const out: { slug: string; rules: string[]; high: string[] }[] = [];
  for (const s of pkg.skills ?? []) {
    const findings = [...screenLeakage(s.description), ...screenLeakage(s.body)];
    if (!findings.length) continue;
    out.push({ slug: s.slug, rules: [...new Set(findings.map((f) => f.rule))], high: [...new Set(findings.filter((f) => f.severity === "high").map((f) => f.rule))] });
  }
  return out;
}

function cronError(r: PackageRoutine): string | null {
  if (!isTimeZone(r.timezone)) return `unknown time zone ${r.timezone}`;
  try {
    CronExpressionParser.parse(r.cron, { tz: r.timezone });
    return null;
  } catch (e) {
    return (e as Error).message.slice(0, 200);
  }
}

/**
 * The package's MCP slot URLs must point to public addresses: an import must not plant a slot that would let this
 * server reach a private, loopback or link-local host (cloud metadata, the database, an admin port) once someone
 * adds a token. Every host is resolved; one that does not resolve is refused too (it cannot be judged).
 */
export async function mcpSlotUrlErrors(pkg: WfosPackage, resolver?: Resolver): Promise<ImportWarning[]> {
  const errors: ImportWarning[] = [];
  for (const s of pkg.mcpSlots) {
    let host = "";
    try {
      const u = new URL(s.url);
      host = u.hostname.replace(/^\[|\]$/g, "");
      // a literal "localhost"-style name never resolves publicly, whatever DNS says today
      if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("local name");
      await assertPublicUrl(u, resolver ? { resolver } : {});
    } catch {
      errors.push({ code: "mcp_url_not_public", name: s.name, host: host || s.url.slice(0, 200) });
    }
  }
  return errors;
}

/** Everything an imported employee will be told and remember, in full, so the admin can read it before importing. */
export interface ImportPreviewEmployee {
  key: string;
  name: string;
  role: string;
  persona: string;
  instructions: string;
  businessContext: string;
  seedMemories: { kind: string; content: string }[];
  /** the slugs its skills are created under */
  skillSlugs: string[];
  toolPermissions: string[];
  egressDomains: string[];
  executionMode: string;
  specialty: string;
}

export interface ImportPreviewSkill {
  slug: string;
  /** the slug it is created under, when that differs (a skill with this slug exists here) */
  as: string | null;
  description: string;
  body: string;
}

export interface ImportPreviewDetails {
  employees: ImportPreviewEmployee[];
  /** every skill in full: imported skills are untrusted and read back into prompts */
  skills: ImportPreviewSkill[];
  /** divisions with their structure and SOP (read back into the head's and members' prompts) */
  teams: { name: string; description: string; head: string | null; codeLead: string | null; members: string[]; subagents: string[]; sop: { en: string; id: string } | null }[];
  routines: { name: string; cron: string; timezone: string; brief: string }[];
  mcpSlots: { name: string; url: string }[];
  /** every host the package's employees may reach from a sandbox (egressDomains), deduplicated */
  egressHosts: string[];
}

function previewDetails(pkg: WfosPackage, p: Plan): ImportPreviewDetails {
  const nameOf = (k: string | null) => (k ? (pkg.employees.find((e) => e.key === k)?.name ?? k) : null);
  return {
    employees: pkg.employees.map((e) => ({
      key: e.key,
      name: e.name,
      role: e.role,
      persona: e.persona,
      instructions: e.instructions,
      businessContext: e.businessContext,
      seedMemories: (e.seedMemories ?? []).map((m) => ({ kind: m.kind, content: m.content })),
      skillSlugs: (e.skillSlugs ?? []).map((s) => p.skillRenames.get(s) ?? s),
      toolPermissions: e.toolPermissions,
      egressDomains: e.egressDomains,
      executionMode: e.executionMode,
      specialty: e.specialty,
    })),
    skills: (pkg.skills ?? []).map((s) => {
      const as = p.skillRenames.get(s.slug) ?? s.slug;
      return { slug: s.slug, as: as === s.slug ? null : as, description: s.description, body: s.body };
    }),
    teams: pkg.teams.map((t) => {
      const d = p.divisions.get(t.key);
      const members = d?.members ?? [];
      return {
        name: t.name,
        description: t.description,
        head: nameOf(d?.leadKey ?? null),
        codeLead: nameOf(t.codeLeadKey),
        members: members.filter((m) => m.role === "member").map((m) => nameOf(m.key)!),
        subagents: members.filter((m) => m.role === "subagent").map((m) => nameOf(m.key)!),
        sop: t.sop && (t.sop.en || t.sop.id) ? t.sop : null,
      };
    }),
    routines: pkg.routines.map((r) => ({ name: r.name, cron: r.cron, timezone: r.timezone, brief: r.brief })),
    mcpSlots: pkg.mcpSlots.map((s) => ({ name: s.name, url: s.url })),
    egressHosts: [...new Set(pkg.employees.flatMap((e) => e.egressDomains))].sort(),
  };
}

export interface ImportPreview {
  ok: boolean;
  name: string;
  /** the full text of what would be imported (instructions, memories, division SOPs, skills), for review */
  details: ImportPreviewDetails;
  will: { employees: number; teams: number; routines: number; skills: number; mcpSlots: number; memories: number };
  warnings: ImportWarning[];
  conflicts: ImportConflict[];
  /** problems that make the commit fail */
  errors: ImportWarning[];
}

export async function previewImport(workspaceId: string, pkg: WfosPackage, opts: { resolver?: Resolver } = {}): Promise<ImportPreview> {
  const p = plan(pkg, await loadExisting(db, workspaceId));
  const errors: ImportWarning[] = [];
  for (const r of pkg.routines) {
    const err = cronError(r);
    if (err) errors.push({ code: "invalid_cron", name: r.name, detail: err });
  }
  errors.push(...(await mcpSlotUrlErrors(pkg, opts.resolver)));
  for (const f of skillLeaks(pkg)) if (f.high.length) errors.push({ code: "skill_leak", slug: f.slug, rules: f.high.join(", ") });
  return {
    ok: errors.length === 0,
    name: pkg.meta.name,
    details: previewDetails(pkg, p),
    will: {
      employees: pkg.employees.length,
      teams: pkg.teams.length,
      routines: pkg.routines.length,
      skills: pkg.skills?.length ?? 0,
      mcpSlots: pkg.mcpSlots.length,
      memories: pkg.employees.reduce((n, e) => n + (e.seedMemories?.length ?? 0), 0),
    },
    warnings: p.warnings,
    conflicts: p.conflicts,
    errors,
  };
}

export interface ImportResult {
  employees: { key: string; id: string; name: string }[];
  teams: { key: string; id: string; name: string }[];
  routines: { id: string; name: string }[];
  skills: { id: string; slug: string; from: string }[];
  mcpSlots: { id: string; name: string; from: string }[];
  memories: number;
  warnings: ImportWarning[];
}

/**
 * Create everything in one transaction, additive only: employees at DRAFT with every tool disabled and no
 * allow-list, routines disabled, MCP slots disabled without a secret, divisions with one division per employee, skills
 * marked untrusted (source "import", a clashing slug renamed) and assigned to the imported employees.
 * Any failure (e.g. an invalid cron) rolls the whole import back.
 */
export async function commitImport(workspaceId: string, pkg: WfosPackage, opts: { resolver?: Resolver; userId?: string } = {}): Promise<ImportResult> {
  // resolved again now (the preview may be minutes old): a slot that is not public is a validation error
  const [bad] = await mcpSlotUrlErrors(pkg, opts.resolver);
  if (bad) {
    throw new HttpError(400, `MCP server ${bad.name} in the package does not point to a public address`, { code: "package_mcp_url_not_public", name: bad.name, host: bad.host });
  }
  // as POST /api/skills: a skill carrying a secret is not saved (the rule names, never the matched text)
  const leak = skillLeaks(pkg).find((f) => f.high.length);
  if (leak) {
    throw new HttpError(400, `Skill ${leak.slug} in the package contains secrets`, { code: "package_skill_leak", slug: leak.slug, rules: leak.high.join(", "), ruleList: leak.high });
  }
  return db.transaction(async (tx) => {
    const p = plan(pkg, await loadExisting(tx, workspaceId));
    const out: ImportResult = { employees: [], teams: [], routines: [], skills: [], mcpSlots: [], memories: 0, warnings: p.warnings };

    for (const s of pkg.mcpSlots) {
      const name = p.mcpRenames.get(s.name)!;
      // disabled and without a secret until an Owner adds the token in Settings (which replaces this config); the
      // worker's getExternalMcpServers skips config.disabled. (encryptSecret("") cannot be decrypted, so no empty box.)
      const [row] = await tx.insert(credentials).values({ workspaceId, kind: "mcp", name, config: { url: s.url, disabled: true }, secretEnc: null }).returning({ id: credentials.id });
      out.mcpSlots.push({ id: row!.id, name, from: s.name });
    }

    // someone else's instructions: read back as data, and reading one taints the run. Enabled, so that the imported
    // employees work as packaged; the admin read every body in the preview
    const skillIds = new Map<string, string>();
    const insertSkill = async (s: PackageSkill, slug: string) => {
      const [row] = await tx
        .insert(skills)
        .values({ workspaceId, slug, description: s.description, body: s.body, source: "import", enabled: true, untrusted: true, provenanceHash: skillProvenanceHash(slug, s.description, s.body), createdBy: opts.userId ?? null })
        .onConflictDoNothing({ target: [skills.workspaceId, skills.slug] })
        .returning({ id: skills.id });
      return row;
    };
    const planned = new Set(p.skillRenames.values());
    for (const s of pkg.skills ?? []) {
      let slug = p.skillRenames.get(s.slug)!;
      let row = await insertSkill(s, slug);
      if (!row) {
        // someone saved a skill with this slug after the plan was made: allocate once more from what exists now
        const now = await tx.select({ slug: skills.slug }).from(skills).where(eq(skills.workspaceId, workspaceId));
        const next = uniqueSkillSlug(s.slug, new Set([...planned, ...now.map((r) => r.slug)]));
        planned.add(next);
        row = await insertSkill(s, next);
        if (!row) throw new HttpError(409, "A skill with this name exists", { code: "skill_slug_taken", slug: next });
        out.warnings.push({ code: "skill_renamed", from: s.slug, to: next });
        slug = next;
      }
      skillIds.set(s.slug, row.id);
      out.skills.push({ id: row.id, slug, from: s.slug });
    }

    const empIds = new Map<string, string>();
    for (const e of pkg.employees) {
      const [row] = await tx
        .insert(employees)
        .values({
          workspaceId,
          name: e.name,
          avatar: e.avatar,
          role: e.role,
          templateKey: e.templateKey ?? null,
          persona: e.persona,
          instructions: e.instructions,
          businessContext: e.businessContext,
          model: e.model,
          autonomyLevel: "DRAFT",
          toolPermissions: e.toolPermissions.map((tool) => ({ tool: renameMcpSelector(tool, p.mcpRenames), enabled: false })),
          allowList: [],
          status: "ACTIVE",
          outputLanguage: e.outputLanguage,
          executionMode: e.executionMode,
          egressDomains: e.egressDomains,
          specialty: e.specialty,
          look: e.look ?? null,
        })
        .returning({ id: employees.id });
      empIds.set(e.key, row!.id);
      out.employees.push({ key: e.key, id: row!.id, name: e.name });
      const assigned = [...new Set((e.skillSlugs ?? []).map((slug) => skillIds.get(slug)!))];
      if (assigned.length) await tx.insert(employeeSkills).values(assigned.map((skillId) => ({ employeeId: row!.id, skillId })));
      const seeds = e.seedMemories ?? [];
      if (seeds.length) {
        // embeddings are back-filled by the worker (backfillMemoryEmbeddings). Seed memories came from someone
        // else's package: recalled as data, and recalling one taints the run
        await tx
          .insert(memories)
          .values(seeds.map((m) => ({ workspaceId, employeeId: row!.id, kind: m.kind, content: m.content, source: "import", untrusted: true, embedding: null })));
        out.memories += seeds.length;
      }
    }

    const teamIds = new Map<string, string>();
    for (const [i, t] of pkg.teams.entries()) {
      const d = p.divisions.get(t.key)!;
      const leadId = d.leadKey ? empIds.get(d.leadKey)! : null;
      const [row] = await tx
        .insert(teams)
        .values({
          workspaceId,
          name: t.name,
          key: d.key,
          description: t.description,
          leadId,
          codeLeadId: t.codeLeadKey ? empIds.get(t.codeLeadKey)! : null,
          responderMode: t.responderMode,
          sop: t.sop ?? { en: "", id: "" },
          color: t.color,
          maxParallel: t.maxParallel,
          sortOrder: i,
        })
        .returning({ id: teams.id });
      teamIds.set(t.key, row!.id);
      if (d.members.length) await tx.insert(teamMembers).values(d.members.map((m) => ({ teamId: row!.id, employeeId: empIds.get(m.key)!, role: m.role })));
      out.teams.push({ key: t.key, id: row!.id, name: t.name });
    }

    for (const r of pkg.routines) {
      const err = cronError(r);
      if (err) throw new HttpError(400, `Invalid cron expression in routine ${r.name}: ${err}`, { code: "invalid_cron", detail: `${r.name}: ${err}` });
      const [row] = await tx
        .insert(routines)
        .values({
          workspaceId,
          name: r.name,
          cron: r.cron,
          timezone: r.timezone,
          brief: r.brief,
          assigneeId: r.assigneeKey ? empIds.get(r.assigneeKey)! : null,
          teamId: r.teamKey ? teamIds.get(r.teamKey)! : null,
          perClient: r.perClient,
          dryRun: r.dryRun,
          enabled: false,
          nextRunAt: null,
        })
        .returning({ id: routines.id });
      out.routines.push({ id: row!.id, name: r.name });
    }
    return out;
  });
}
