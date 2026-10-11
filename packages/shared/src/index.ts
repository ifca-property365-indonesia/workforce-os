import { z } from "zod";
import { BEARDS, GLASSES, HAIR_COLORS, HAIR_STYLES, HATS, SHIRT_COLORS, SKIN_TONES, type OfficeLook } from "./office";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export const LOCALES = ["id", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const OUTPUT_LANGUAGES = ["inherit", "id", "en"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];
/** last resort when neither the user, the workspace nor the browser says anything usable */
export const FALLBACK_LOCALE: Locale = "en";
export const LOCALE_NAMES: Record<Locale, string> = { id: "Bahasa Indonesia", en: "English" };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** Pick the best supported locale from an Accept-Language header (q-values respected). */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { base: (tag ?? "").toLowerCase().split("-")[0]!, q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((x) => x.base && !Number.isNaN(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) {
    if (r.base === "in" || r.base === "ms") return "id"; // legacy code for Indonesian; Malay is close enough to prefer id over en
    if (isLocale(r.base)) return r.base;
  }
  return null;
}

/** User preference → workspace default → browser → fallback. */
export function resolveLocale(user: string | null | undefined, workspace: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(user)) return user;
  if (isLocale(workspace)) return workspace;
  return localeFromAcceptLanguage(acceptLanguage) ?? FALLBACK_LOCALE;
}

/** The language an employee writes in; null = no instruction (mirror the request). */
export function employeeOutputLocale(setting: OutputLanguage | null | undefined, workspaceDefault: string | null | undefined): Locale | null {
  if (setting === "id" || setting === "en") return setting;
  return isLocale(workspaceDefault) ? workspaceDefault : null;
}

export const EXECUTION_MODES = ["tool", "workspace"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** An employee's character in the office (see office.ts). */
export const officeLookSchema = z.object({
  skin: z.number().int().min(0).max(SKIN_TONES.length - 1),
  hair: z.enum(HAIR_STYLES),
  hairColor: z.number().int().min(0).max(HAIR_COLORS.length - 1),
  beard: z.enum(BEARDS),
  glasses: z.enum(GLASSES),
  hat: z.enum(HATS),
  shirt: z.number().int().min(0).max(SHIRT_COLORS.length - 1),
  logo: z.boolean(),
});
export type { OfficeLook };

/** Claude Code built-ins enabled in Workspace mode (inside the sandbox; Bash is classified per call). */
export const WORKSPACE_BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "TodoWrite", "Task", "Skill", "NotebookEdit"] as const;

/** Host names an employee may reach from its sandbox; registry-style hosts only, no IPs, no ports. */
export const egressDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, "a host name like registry.npmjs.org or *.pypi.org");

export const AUTONOMY_LEVELS = ["DRAFT", "QUEUE", "EXECUTE", "CLOSE"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  DRAFT: "Produces drafts only. Nothing leaves the system.",
  QUEUE: "Prepares actions and queues them for human approval.",
  EXECUTE: "Runs reversible actions automatically; irreversible ones need approval.",
  CLOSE: "Completes tasks end-to-end within an Owner allow-listed scope.",
};

export const EMPLOYEE_STATUSES = ["ACTIVE", "PAUSED", "PAUSED_BUDGET", "ARCHIVED"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const TASK_STATUSES = ["QUEUED", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** EXECUTING = claimed by one executor; an approved action runs at most once (a crash leaves it EXECUTING for a human to check). */
export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "EXECUTING", "REJECTED", "EXECUTED", "FAILED", "EXPIRED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const STEP_KINDS = [
  "llm",
  "tool",
  "guard",
  "approval",
  "agent_message",
  "compaction",
  "budget",
  "system",
  "error",
  "incident",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const TASK_SOURCES = ["chat", "board", "routine", "team", "replay", "demo", "webhook"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ["accepted", "duplicate", "rejected", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
/** Inbound webhook limits: body size, requests per trigger per minute, payload excerpt kept per delivery. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const WEBHOOK_RATE_PER_MIN = 60;
export const WEBHOOK_EXCERPT_CHARS = 2000;
/** Prefix of personal API tokens (wfos_<random>). */
export const API_TOKEN_PREFIX = "wfos_";

/** Where a skill came from: written by a person, learned (proposed by an employee, approved), imported, built in. */
export const SKILL_SOURCES = ["user", "learned", "import", "builtin"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];
export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 64 * 1024;
/** Skills listed (one line each) in an employee's system prompt. */
export const SKILL_INDEX_MAX = 30;

/** Something went wrong with a run that a person or the team lead should look at. */
export const INCIDENT_KINDS = ["failed", "stalled", "loop", "could_not_start", "routine_failed"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
/** open → handling (the lead got a turn) → resolved; escalated = a person was notified; muted = over the hourly cap */
export const INCIDENT_STATUSES = ["open", "handling", "resolved", "escalated", "muted"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
/** Automatic retries a lead may make per subtask, and auto-handled incidents per workspace per hour. */
export const INCIDENT_RETRY_LIMIT = 2;
export const INCIDENT_HOURLY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Task state machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["AWAITING_APPROVAL", "DONE", "FAILED", "CANCELLED", "QUEUED"],
  AWAITING_APPROVAL: ["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELLED"],
  DONE: [],
  FAILED: ["QUEUED"],
  CANCELLED: ["QUEUED"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal task transition ${from} -> ${to}`);
}

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["DONE", "FAILED", "CANCELLED"];

// ---------------------------------------------------------------------------
// Tool registry (classification is the single source of truth for the gate)
// ---------------------------------------------------------------------------

export type ToolClass = "reversible" | "irreversible";

export interface ToolMeta {
  name: string;
  label: string;
  description: string;
  class: ToolClass;
  /** credits charged per call, on top of tokens */
  credits: number;
  category: "knowledge" | "memory" | "clients" | "drafting" | "comms" | "billing" | "team" | "web" | "tasks" | "code" | "routines";
}

export const BUILTIN_TOOLS: readonly ToolMeta[] = [
  { name: "kb_search", label: "Knowledge base search", description: "Search the workspace knowledge base with citations", class: "reversible", credits: 0.1, category: "knowledge" },
  { name: "memory_search", label: "Recall memory", description: "Search the employee's long-term memory", class: "reversible", credits: 0.05, category: "memory" },
  { name: "memory_save", label: "Save memory", description: "Store a fact in the employee's long-term memory", class: "reversible", credits: 0.05, category: "memory" },
  { name: "list_clients", label: "List clients", description: "List clients and projects from master data", class: "reversible", credits: 0.05, category: "clients" },
  { name: "get_client", label: "Get client", description: "Read one client with contacts and projects", class: "reversible", credits: 0.05, category: "clients" },
  { name: "list_tasks", label: "List tasks", description: "Read recent tasks and deliverables in the workspace", class: "reversible", credits: 0.05, category: "tasks" },
  { name: "web_fetch", label: "Fetch web page", description: "Read a public web page (text only)", class: "reversible", credits: 0.2, category: "web" },
  { name: "draft_document", label: "Draft document", description: "Create a document or code deliverable (with diff vs previous version)", class: "reversible", credits: 0.05, category: "drafting" },
  { name: "draft_email", label: "Draft email", description: "Write an email draft without sending it", class: "reversible", credits: 0.05, category: "drafting" },
  { name: "draft_invoice", label: "Draft invoice", description: "Generate an invoice PDF draft for a client", class: "reversible", credits: 0.1, category: "billing" },
  { name: "create_task", label: "Create task", description: "Create a task on the board (from chat)", class: "reversible", credits: 0.05, category: "tasks" },
  { name: "skill_read", label: "Read skill", description: "Read one of your assigned skills (SKILL.md instructions) by slug; granted automatically while you have skills assigned", class: "reversible", credits: 0.02, category: "knowledge" },
  { name: "skill_propose", label: "Propose skill", description: "Propose a new reusable skill (SKILL.md) from what you learned; a human approves it before it is saved and assigned to you", class: "reversible", credits: 0.05, category: "knowledge" },
  { name: "propose_routine", label: "Propose routine", description: "Propose a recurring routine (cron schedule + brief); a human approves it before it is created", class: "reversible", credits: 0.05, category: "routines" },
  { name: "delegate_subtask", label: "Delegate subtask", description: "Team lead: assign a subtask to a team member", class: "reversible", credits: 0.05, category: "team" },
  { name: "request_revision", label: "Request revision", description: "Team lead: send a subtask back with feedback", class: "reversible", credits: 0.05, category: "team" },
  { name: "retry_subtask", label: "Retry subtask", description: "Team lead: run a failed subtask again (bounded retries)", class: "reversible", credits: 0.05, category: "team" },
  { name: "reassign_subtask", label: "Reassign subtask", description: "Team lead: give a failed subtask to another team member", class: "reversible", credits: 0.05, category: "team" },
  { name: "message_teammate", label: "Message teammate", description: "Send a structured message to another employee", class: "reversible", credits: 0.05, category: "team" },
  { name: "send_email", label: "Send email", description: "Send an email via workspace SMTP", class: "irreversible", credits: 1, category: "comms" },
  { name: "send_invoice", label: "Send invoice", description: "Email an invoice PDF to a client", class: "irreversible", credits: 1, category: "billing" },
  { name: "git_push", label: "Push branch", description: "Workspace mode: push your committed work to agent/<task> on the remote (the platform pushes after approval)", class: "irreversible", credits: 0.5, category: "code" },
  { name: "create_pull_request", label: "Open pull request", description: "Workspace mode: open a pull/merge request from your branch (after approval)", class: "irreversible", credits: 0.5, category: "code" },
  { name: "post_webhook", label: "Publish to webhook", description: "Publish a message to a configured webhook (Slack/Telegram/WhatsApp gateway)", class: "irreversible", credits: 0.5, category: "comms" },
] as const;

export const TOOL_BY_NAME: Record<string, ToolMeta> = Object.fromEntries(BUILTIN_TOOLS.map((t) => [t.name, t]));

const IRREVERSIBLE_VERBS = [
  "send", "publish", "post", "pay", "charge", "refund", "transfer", "delete", "remove", "destroy", "drop",
  "merge", "deploy", "release", "push", "create_pr", "close", "archive", "revoke", "invite", "submit", "approve",
  "update", "write", "create", "cancel",
];
const REVERSIBLE_VERBS = ["get", "list", "read", "search", "find", "fetch", "query", "describe", "view", "draft", "preview", "navigate"];
/**
 * Verbs that reach a person or move money/data out, or destroy something: irreversible wherever they appear,
 * even after a leading read verb (`get_and_delete_file`). Nouns such as "post"/"message" are not in this list,
 * so `get_post` / `list_messages` stay reads.
 */
/**
 * Irreversible verbs that are also common nouns. Only directly after a leading read verb (`get_post`,
 * `list_release_notes`) do they name the thing being read; anywhere else they stay verbs.
 */
const NOUN_LIKE_VERBS = ["post", "release"];
/** Words that chain a second action onto a read (`fetch_and_release_funds`): such names never count as reads. */
const CHAIN_WORDS = ["and", "then", "or", "also", "plus", "after", "before", "with"];
const OUTBOUND_VERBS = [
  "send", "reply", "forward", "publish", "pay", "charge", "refund", "transfer", "invite", "share", "submit",
  "approve", "deploy", "merge", "push", "delete", "remove", "destroy", "drop", "revoke", "cancel", "purge",
];

/**
 * Lower-case word tokens of a tool name. camelCase, PascalCase and acronym boundaries are split
 * before lower-casing (`listContacts` → list, contacts; `getHTTPResponse` → get, http, response),
 * then anything that is not a letter separates tokens (`send_email` → send, email).
 */
function toolNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * Classify any tool name. Built-ins use the registry; unknown tools (e.g. from external
 * MCP servers) are classified by verb, and default to irreversible when unsure (fail closed).
 */
export function classifyTool(name: string, overrides?: Record<string, ToolClass>): ToolClass {
  const bare = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name;
  if (overrides?.[name]) return overrides[name];
  if (overrides?.[bare]) return overrides[bare];
  const builtin = TOOL_BY_NAME[bare];
  if (builtin) return builtin.class;
  const tokens = toolNameTokens(bare);
  if (tokens.some((t) => OUTBOUND_VERBS.includes(t))) return "irreversible";
  // A leading read verb names a read even when a later token is a noun that doubles as a verb (get_post,
  // list_release). Any other write verb (getOrCreateContact, readThenUpdateRow) still fails closed below.
  if (
    tokens.length > 1 &&
    REVERSIBLE_VERBS.includes(tokens[0]!) &&
    NOUN_LIKE_VERBS.includes(tokens[1]!) &&
    !tokens.some((t) => CHAIN_WORDS.includes(t)) &&
    tokens.slice(2).every((t) => !IRREVERSIBLE_VERBS.includes(t))
  ) {
    return "reversible";
  }
  if (tokens.some((t) => REVERSIBLE_VERBS.includes(t)) && !tokens.some((t) => IRREVERSIBLE_VERBS.includes(t))) {
    return "reversible";
  }
  return "irreversible";
}

// ---------------------------------------------------------------------------
// Tool permissions & allow-list
// ---------------------------------------------------------------------------

/** Built-in tool name, `mcp:<server>`, or `mcp:<server>:<tool or glob>` (at most 8 "*"). */
const TOOL_SELECTOR_RE = /^(?:[a-z][a-z0-9_]*|mcp:[a-z0-9-]+(?:_[a-z0-9-]+)*(?::[A-Za-z0-9_.*-]{1,128})?)$/;
export const toolPermissionSchema = z.object({
  tool: z
    .string()
    .min(1)
    .max(200)
    .regex(TOOL_SELECTOR_RE, "invalid tool selector")
    .refine((t) => (t.match(/\*/g)?.length ?? 0) <= 8, "too many wildcards"),
  enabled: z.boolean().default(true),
  /** per-tool autonomy override; falls back to employee autonomyLevel */
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
});
export type ToolPermission = z.infer<typeof toolPermissionSchema>;

/**
 * Owner-managed allow-list entry: lets an irreversible tool run without per-action approval
 * when the employee is at CLOSE autonomy and the action matches the scope.
 */
export const allowListEntrySchema = z.object({
  tool: z.string().min(1),
  /** e.g. recipient domains for send_email / send_invoice */
  recipientDomains: z.array(z.string()).default([]),
  /** restrict to these client ids (empty = any client) */
  clientIds: z.array(z.string()).default([]),
  /** max invoice amount (send_invoice) */
  maxAmount: z.number().nonnegative().optional(),
  note: z.string().optional(),
});
export type AllowListEntry = z.infer<typeof allowListEntrySchema>;

/** Which rule produced a gate decision (shown in the Activity Inspector). */
export type GateRule = "not_granted" | "reversible" | "dry_run" | "autonomy_draft" | "allow_list" | "autonomy" | "taint" | "leak";

export type GateDecision =
  | { kind: "run"; rule?: GateRule }
  | { kind: "draft"; reason: string; rule?: GateRule }
  | { kind: "approval"; reason: string; rule?: GateRule }
  | { kind: "simulate"; reason: string; rule?: GateRule }
  | { kind: "deny"; reason: string; rule?: GateRule };

/**
 * Does a permission / allow-list `pattern` cover `toolName`? Exact match, or an external MCP selector
 * `mcp:<server>:<glob>` where `*` matches any run of characters within the tool name (`mcp:crm:list_*`),
 * or the server-level grant `mcp:<server>` covering every `mcp:<server>:<tool>`.
 */
export function toolPatternMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (!toolName.startsWith("mcp:") || !pattern.startsWith("mcp:")) return false;
  const [, server, ...toolParts] = toolName.split(":");
  const tool = toolParts.join(":");
  if (!server || !tool) return false;
  const [, pServer, ...patternParts] = pattern.split(":");
  if (pServer !== server) return false;
  if (patternParts.length === 0) return true; // server-level grant `mcp:<server>`
  // Compare on the name the Claude SDK actually exposes (case-folded, [^a-z0-9_-] → "_"), so a rule saved with
  // the server's raw tool name (`Contacts.Delete`) still governs the call the gate sees (`contacts_delete`).
  return globMatches(normalizeMcpName(patternParts.join(":"), true), normalizeMcpName(tool));
}

/**
 * MCP tool names as the gate compares them: lower-case, every character outside [a-z0-9_-] replaced by "_"
 * (Claude Code normalises MCP tool names the same way). `keepStars` preserves "*" in selectors.
 */
export function normalizeMcpName(name: string, keepStars = false): string {
  return name.toLowerCase().replace(keepStars ? /[^a-z0-9_*-]/g : /[^a-z0-9_-]/g, "_");
}

/** Linear-time glob match where "*" matches any run of characters (no regex, so no catastrophic backtracking). */
export function globMatches(glob: string, text: string): boolean {
  let g = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] !== "*" && glob[g] === text[t]) {
      g++;
      t++;
    } else if (g < glob.length && glob[g] === "*") {
      star = g++;
      mark = t;
    } else if (star !== -1) {
      g = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === "*") g++;
  return g === glob.length;
}

/** Specificity of a matching pattern: exact 3, glob 2 (longer literal part first), server-level 1. */
function patternRank(pattern: string, toolName: string): number {
  if (pattern === toolName || (!pattern.includes("*") && pattern.split(":").length > 2)) return 3;
  if (pattern.includes("*")) return 2 + pattern.replace(/\*/g, "").length / 1000;
  return 1;
}

/**
 * The permission that governs `toolName`: undefined when nothing grants it. Any matching entry that is disabled
 * wins (an explicit "no" beats a broader "yes"); otherwise the most specific enabled entry decides autonomy.
 */
export function matchToolPermission(toolName: string, permissions: ToolPermission[]): ToolPermission | undefined {
  const matches = permissions.filter((p) => toolPatternMatches(p.tool, toolName));
  if (matches.length === 0) return undefined;
  const denied = matches.find((p) => !p.enabled);
  if (denied) return denied;
  return [...matches].sort((a, b) => patternRank(b.tool, toolName) - patternRank(a.tool, toolName))[0];
}

export interface GateInput {
  toolName: string;
  toolClass: ToolClass;
  employeeAutonomy: AutonomyLevel;
  permissions: ToolPermission[];
  allowList: AllowListEntry[];
  dryRun: boolean;
  /** recipients / client / amount extracted from the proposed payload, used for allow-list scope */
  scope?: { recipients?: string[]; clientId?: string | null; amount?: number };
}

export function effectiveAutonomy(toolName: string, employeeAutonomy: AutonomyLevel, permissions: ToolPermission[]): AutonomyLevel {
  const p = matchToolPermission(toolName, permissions);
  return p?.autonomy ?? employeeAutonomy;
}

export function allowListMatches(entry: AllowListEntry, scope: GateInput["scope"]): boolean {
  if (entry.recipientDomains.length > 0) {
    const recips = scope?.recipients ?? [];
    if (recips.length === 0) return false;
    const ok = recips.every((r) => {
      const domain = r.split("@")[1]?.toLowerCase().trim();
      return !!domain && entry.recipientDomains.some((d) => d.toLowerCase().replace(/^@/, "") === domain);
    });
    if (!ok) return false;
  }
  if (entry.clientIds.length > 0) {
    if (!scope?.clientId || !entry.clientIds.includes(scope.clientId)) return false;
  }
  if (entry.maxAmount !== undefined && (scope?.amount ?? Infinity) > entry.maxAmount) return false;
  return true;
}

/**
 * The single, deterministic gate. Called by the tool layer for every tool call.
 * Never trusts the model: only configuration decides.
 */
export function decideGate(input: GateInput): GateDecision {
  const perm = matchToolPermission(input.toolName, input.permissions);
  if (!perm || !perm.enabled) {
    return { kind: "deny", reason: `Tool "${input.toolName}" is not granted to this employee.`, rule: "not_granted" };
  }
  if (input.toolClass === "reversible") return { kind: "run", rule: "reversible" };

  // Irreversible from here on.
  if (input.dryRun) return { kind: "simulate", reason: "Dry run: irreversible action replaced by a mock.", rule: "dry_run" };
  const level = effectiveAutonomy(input.toolName, input.employeeAutonomy, input.permissions);
  if (level === "DRAFT") return { kind: "draft", reason: "Autonomy DRAFT: saved as a draft, nothing was sent.", rule: "autonomy_draft" };
  if (level === "CLOSE") {
    const entry = input.allowList.find((e) => toolPatternMatches(e.tool, input.toolName) && allowListMatches(e, input.scope));
    if (entry) return { kind: "run", rule: "allow_list" };
    return { kind: "approval", reason: "Irreversible action outside the Owner allow-list requires approval.", rule: "autonomy" };
  }
  return { kind: "approval", reason: `Irreversible action requires approval (autonomy ${level}).`, rule: "autonomy" };
}

/**
 * Run-level safety signals on top of the configured gate. Once a run is tainted by untrusted
 * content (or the payload looks like it leaks a secret), no irreversible action may run
 * unattended — not even one the Owner allow-listed.
 */
export function applyRunSignals(decision: GateDecision, s: { toolClass: ToolClass; tainted: boolean; highLeak?: boolean }): GateDecision {
  if (decision.kind !== "run" || s.toolClass !== "irreversible") return decision;
  if (s.highLeak) return { kind: "approval", reason: "Output guard found possible secrets/PII in the payload.", rule: "leak" };
  if (s.tainted) return { kind: "approval", reason: "This run handled untrusted content (external input, a web page or tool output), so irreversible actions need approval.", rule: "taint" };
  return decision;
}

// ---------------------------------------------------------------------------
// Pricing (1 credit = USD 0.01). Published in Settings → Pricing.
// ---------------------------------------------------------------------------

export const CREDIT_USD = 0.01;

export interface ModelPrice {
  model: string;
  label: string;
  /** credits per 1K input tokens */
  inputPer1k: number;
  /** credits per 1K output tokens */
  outputPer1k: number;
  /** credits per 1K cache-read tokens */
  cacheReadPer1k: number;
  /** credits per 1K cache-write tokens */
  cacheWritePer1k: number;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export const DEFAULT_MODEL_PRICES: readonly ModelPrice[] = [
  { model: "claude-opus-5-5", label: "Claude Opus 5.5", inputPer1k: 0.4, outputPer1k: 2.0, cacheReadPer1k: 0.02, cacheWritePer1k: 0.5 },
  { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inputPer1k: 0.2, outputPer1k: 1.0, cacheReadPer1k: 0.02, cacheWritePer1k: 0.25 },
  { model: "claude-haiku-5-5", label: "Claude Haiku 5.5", inputPer1k: 0.01, outputPer1k: 0.05, cacheReadPer1k: 0.001, cacheWritePer1k: 0.0125 },
  { model: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputPer1k: 0.1, outputPer1k: 0.5, cacheReadPer1k: 0.01, cacheWritePer1k: 0.125 },
  { model: "claude-fable-5-1", label: "Claude Fable 5.1", inputPer1k: 1.0, outputPer1k: 5.0, cacheReadPer1k: 0.025, cacheWritePer1k: 1.25 },
];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function computeLlmCredits(usage: TokenUsage, price: ModelPrice | undefined): number {
  const p = price ?? DEFAULT_MODEL_PRICES[0]!;
  const c =
    (usage.inputTokens / 1000) * p.inputPer1k +
    (usage.outputTokens / 1000) * p.outputPer1k +
    ((usage.cacheReadTokens ?? 0) / 1000) * p.cacheReadPer1k +
    ((usage.cacheWriteTokens ?? 0) / 1000) * p.cacheWritePer1k;
  return Math.round(c * 10000) / 10000;
}

export function roundCredits(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Realtime events (worker → Redis pub/sub → SSE → UI)
// ---------------------------------------------------------------------------

export type RealtimeEvent =
  | { type: "task.updated"; taskId: string; status: TaskStatus; employeeId?: string | null; title?: string }
  | { type: "task.created"; taskId: string; parentTaskId?: string | null; title: string; employeeId?: string | null }
  | { type: "step.created"; taskId: string | null; conversationId?: string | null; step: StepDTO }
  | { type: "chat.delta"; conversationId: string; messageId: string; text: string }
  | { type: "chat.message"; conversationId: string; message: ChatMessageDTO }
  | { type: "approval.created"; approvalId: string; taskId: string | null; conversationId?: string | null; title: string }
  | { type: "approval.updated"; approvalId: string; status: ApprovalStatus }
  | { type: "employee.updated"; employeeId: string; status: EmployeeStatus }
  | { type: "killswitch"; engaged: boolean }
  | { type: "replay.updated"; replayId: string; status: string }
  | { type: "demo.stage"; stage: string; detail: string }
  | { type: "limits.updated"; windows: { type: string; status: string; utilization: number | null; resetsAt: string | null }[] }
  | { type: "limits.warning"; window: string; threshold: number; resetsAt: string | null }
  | { type: "quota.paused"; until: string | null; reason: string }
  | { type: "quota.resumed" };

export interface StepDTO {
  id: string;
  taskId: string | null;
  employeeId: string | null;
  kind: StepKind;
  name: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  credits: number;
  input?: unknown;
  output?: unknown;
  status: string;
  createdAt: string;
}

/** Who answers an un-mentioned message in a team chat. */
export const TEAM_RESPONDER_MODES = ["lead", "everyone", "mentions", "auto"] as const;
export type TeamResponderMode = (typeof TEAM_RESPONDER_MODES)[number];

/** Fast, cheap model used to pick a responder in team chats set to "auto". */
export const ROUTING_MODEL = "claude-haiku-5-5";
/** Minimum classifier confidence to act on its pick; below it the lead answers. */
export const ROUTING_MIN_CONFIDENCE = 0.6;
/** Most teammates that answer one team-chat message (lead first); the rest are listed in meta.skippedResponders. */
export const MAX_RESPONDERS_PER_TURN = 5;

/** How a responder was chosen for a team-chat turn. */
export interface RoutedBy {
  mode: "mention" | "everyone" | "lead" | "auto" | "fallback";
  /** classifier confidence (mode "auto") */
  confidence?: number;
  /** why the lead answered instead (mode "fallback"): timeout, error, low_confidence, invalid */
  reason?: string;
}

/** An irreversible action that ran without a human because an allow-list rule matched. */
export interface AutoActionChip {
  tool: string;
  label: string;
}

/** Structured extras on a chat message; every field is optional so old rows ({}) stay valid. */
export interface MessageMeta {
  /** user messages folded into this assistant turn (rapid messages coalesce into one reply) */
  turnMessageIds?: string[];
  /** user messages: employees @mentioned (team chat) */
  mentions?: string[];
  /** user messages: @semua / @everyone */
  mentionAll?: boolean;
  /** assistant messages: how this responder was picked (team chat) */
  routedBy?: RoutedBy;
  /** assistant messages: irreversible actions that ran via the allow-list */
  chips?: AutoActionChip[];
  /** system messages: the approval this receipt reports on */
  approvalId?: string;
  /** system notes the UI localises: nobody mentioned in a "mentions" team chat / responder busy (employeeId set) */
  hint?: "no_responder" | "busy";
  /** responders beyond the per-turn cap that were not run (team chat) */
  skippedResponders?: string[];
  /**
   * Untrusted content: user messages from a machine client (API token with markUntrusted), and assistant replies /
   * approval receipts written by a tainted run. Later turns fence these rows and start tainted.
   */
  untrusted?: boolean;
}

/** An approval shown inline under the chat message that raised it. */
export interface ChatApprovalDTO {
  id: string;
  toolName: string;
  title: string;
  reason: string;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  feedback: string | null;
  executionResult: Record<string, unknown> | null;
  /** input/output guard findings (leak / injection) recorded when the approval was raised */
  guardFindings: { rule: string; severity: "low" | "medium" | "high"; excerpt: string }[];
  decidedAt: string | null;
  createdAt: string;
}

export interface ChatMessageDTO {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  employeeId?: string | null;
  taskId?: string | null;
  attachments?: { name: string; size: number; documentId?: string }[];
  status?: string;
  meta?: MessageMeta;
  /** approvals raised by this (assistant) message */
  approvals?: ChatApprovalDTO[];
  /** previous message on this branch */
  parentId?: string | null;
  /** when this message has siblings (edited / regenerated versions): its position among them */
  branch?: { index: number; count: number; siblingIds: string[] };
  createdAt: string;
}

/** Pub/sub channels are global across Redis DB indexes, so non-production instances namespace them. */
export function channelFor(workspaceId: string, namespace = ""): string {
  return `${namespace ? `${namespace}:` : ""}wfos:events:${workspaceId}`;
}

export function controlChannel(namespace = ""): string {
  return `${namespace ? `${namespace}:` : ""}wfos:control`;
}

// ---------------------------------------------------------------------------
// Queue job payloads
// ---------------------------------------------------------------------------

export const QUEUE_RUNS = "wfos-runs";
export const QUEUE_ACTIONS = "wfos-actions";
export const QUEUE_INGEST = "wfos-ingest";
export const QUEUE_MISC = "wfos-misc";

export type RunJob =
  | { kind: "task"; taskId: string; workspaceId: string; resumeNote?: string }
  | { kind: "chat"; conversationId: string; messageId: string; workspaceId: string }
  /** answer this user message again: a new assistant sibling below it, which becomes the active leaf */
  | { kind: "chat_regenerate"; conversationId: string; userMessageId: string; workspaceId: string };

export type ActionJob =
  | { kind: "execute_approval"; approvalId: string; workspaceId: string }
  | { kind: "rejected_approval"; approvalId: string; workspaceId: string };
export type IngestJob = { kind: "ingest"; documentId: string; workspaceId: string };
export type MiscJob =
  | { kind: "replay"; replayId: string; workspaceId: string }
  | { kind: "demo"; workspaceId: string; userId: string }
  | { kind: "routine_run"; routineId: string; workspaceId: string; userId?: string }
  | NotifyJob;

/**
 * A notification. `notificationKind` decides per-user channel preferences (missing: sent to everyone, stored as
 * kind "info"); `employeeId` is the employee it is about (per-user mutes); `userId` targets one member (null = all).
 */
export type NotifyJob = {
  kind: "notify";
  workspaceId: string;
  subject: string;
  text: string;
  link?: string;
  approvalId?: string;
  notificationKind?: NotificationKind;
  employeeId?: string | null;
  userId?: string | null;
};

// ---------------------------------------------------------------------------
// API input schemas (shared by web route handlers and UI forms)
// ---------------------------------------------------------------------------

export const signupSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(8).max(200),
  workspaceName: z.string().min(1).max(120),
});

export const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });

export const employeeInputSchema = z.object({
  name: z.string().min(1).max(80),
  avatar: z.string().max(16).default("🤖"),
  role: z.string().min(1).max(80),
  templateKey: z.string().optional().nullable(),
  persona: z.string().max(4000).default(""),
  instructions: z.string().max(20000).default(""),
  businessContext: z.string().max(20000).default(""),
  model: z.string().default(DEFAULT_MODEL),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).default("DRAFT"),
  toolPermissions: z.array(toolPermissionSchema).default([]),
  dailyBudget: z.number().nonnegative().max(1_000_000).default(200),
  outputLanguage: z.enum(OUTPUT_LANGUAGES).default("inherit"),
  executionMode: z.enum(EXECUTION_MODES).default("tool"),
  department: z.string().regex(/^[a-z0-9_-]{1,40}$/).nullable().optional(),
  egressDomains: z.array(egressDomainSchema).max(50).default([]),
  /** office character; null derives one from the id */
  look: officeLookSchema.nullable().optional(),
});
export type EmployeeInput = z.infer<typeof employeeInputSchema>;

export const taskInputSchema = z.object({
  title: z.string().min(1).max(200),
  brief: z.string().max(20000).default(""),
  assigneeId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  dryRun: z.boolean().default(false),
  start: z.boolean().default(true),
  /** Workspace mode: repository to check out on branch agent/<task> */
  repositoryId: z.string().uuid().nullable().optional(),
});

/** A git repository connected to a workspace (https only; the token never reaches the agent). */
export const repositoryInputSchema = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, "letters, digits, dot, dash, underscore"),
  provider: z.enum(["github", "gitlab", "git"]),
  url: z.url().refine((u) => /^https:\/\/[^@\s]+$/.test(u) && !/\s/.test(u), "an https clone URL without credentials"),
  defaultBranch: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/).default("main"),
  token: z.string().trim().min(10).max(500).optional(),
});

export const ROUTINE_OVERLAP_MODES = ["skip", "queue"] as const;
export type RoutineOverlap = (typeof ROUTINE_OVERLAP_MODES)[number];

export const routineInputSchema = z.object({
  name: z.string().min(1).max(120),
  cron: z
    .string()
    .min(9)
    .max(120)
    .refine((c) => c.trim().split(/\s+/).length === 5, "cron needs exactly 5 fields (minute hour day month weekday)"),
  timezone: z.string().default("Asia/Jakarta"),
  brief: z.string().min(1).max(20000),
  assigneeId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  perClient: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  enabled: z.boolean().default(true),
  overlap: z.enum(ROUTINE_OVERLAP_MODES).default("skip"),
});

/**
 * A routine firing (routine_runs.status): "dispatched" while any of its tasks is still open,
 * then "done" when every task finished DONE, else "failed" (also used when dispatch itself failed).
 */
export const ROUTINE_RUN_STATUSES = ["dispatched", "done", "failed", "missed", "skipped_overlap"] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];
/** A firing that is more than this late (worker was down) is recorded as missed instead of run. */
export const ROUTINE_CATCH_UP_MS = 12 * 60 * 60_000;

export const MEMORY_EVENT_ACTIONS = ["create", "update", "delete", "expire", "supersede", "restore"] as const;
export type MemoryEventAction = (typeof MEMORY_EVENT_ACTIONS)[number];
/** Nightly tidy changes at most this share of an employee's memories per pass. */
export const MEMORY_TIDY_MAX_SHARE = 0.2;
/** Cosine similarity above which two memories are near-duplicates (the older one is superseded). */
export const MEMORY_NEAR_DUPLICATE = 0.95;

/** Kinds a person can switch per channel in their notification preferences. */
export const NOTIFICATION_KINDS = ["approval", "task_done", "task_failed", "incident", "routine_failed", "limits", "chat_reply"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_CHANNELS = ["inapp", "email", "telegram", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
/** { [kind]: { [channel]: boolean } }; anything missing means "on". */
export type NotificationChannelPrefs = Partial<Record<NotificationKind, Partial<Record<NotificationChannel, boolean>>>>;

export const clientInputSchema = z.object({
  name: z.string().min(1).max(160),
  email: z.email().or(z.literal("")).default(""),
  contacts: z
    .array(z.object({ name: z.string(), email: z.email().or(z.literal("")), role: z.string().default("") }))
    .default([]),
  notes: z.string().max(5000).default(""),
  currency: z.string().default("IDR"),
});

export const projectInputSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(160),
  status: z.string().default("active"),
  description: z.string().max(5000).default(""),
  hourlyRate: z.number().nonnegative().default(0),
  deadline: z.iso.date().nullable().optional(),
  progress: z.number().int().min(0).max(100).default(0),
});

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const smtpSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().default(""),
  password: z.string().optional(),
  fromAddress: z.string().min(3),
});

export const teamInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  leadId: z.string().uuid().nullable(),
  memberIds: z.array(z.string().uuid()).default([]),
  responderMode: z.enum(TEAM_RESPONDER_MODES).default("lead"),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "edit_approve", "reject"]),
  editedPayload: z.record(z.string(), z.unknown()).optional(),
  feedback: z.string().max(5000).optional(),
});

// ---------------------------------------------------------------------------
// Payload shapes for irreversible actions (rendered in the Approvals inbox)
// ---------------------------------------------------------------------------

export const emailPayloadSchema = z.object({
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).default([]),
  subject: z.string().min(1),
  body: z.string().min(1),
  html: z.boolean().default(false),
  clientId: z.string().nullable().optional(),
});
export type EmailPayload = z.infer<typeof emailPayloadSchema>;

export const invoiceLineSchema = z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() });
export const invoicePayloadSchema = z.object({
  clientId: z.string(),
  invoiceNumber: z.string(),
  currency: z.string().default("IDR"),
  lines: z.array(invoiceLineSchema).min(1),
  dueDate: z.string(),
  notes: z.string().default(""),
  to: z.array(z.string()).default([]),
  subject: z.string().default(""),
  body: z.string().default(""),
});
export type InvoicePayload = z.infer<typeof invoicePayloadSchema>;

export function invoiceTotal(p: Pick<InvoicePayload, "lines">): number {
  return p.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
}

export const webhookPayloadSchema = z.object({ channel: z.string().default("default"), text: z.string().min(1) });

export function formatCredits(n: number): string {
  return n < 1 ? n.toFixed(3) : n.toFixed(2);
}
export * from "./mcp-oauth";
export * from "./package";
