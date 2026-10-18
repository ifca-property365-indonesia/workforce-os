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

/** handoff: made by handoff_to_division (another division's head handed the work over; chains are limited) */
export const TASK_SOURCES = ["chat", "board", "routine", "team", "replay", "demo", "webhook", "handoff"] as const;
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
export const INCIDENT_KINDS = ["failed", "stalled", "loop", "could_not_start", "routine_failed", "out_of_memory", "time_limit"] as const;
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
  /** granted to every task run without an explicit permission (an explicit disabled entry still wins) */
  implicit?: "task";
}

export const BUILTIN_TOOLS: readonly ToolMeta[] = [
  { name: "kb_search", label: "Knowledge base search", description: "Search the workspace knowledge base with citations", class: "reversible", credits: 0.1, category: "knowledge" },
  { name: "memory_search", label: "Recall memory", description: "Search the employee's long-term memory", class: "reversible", credits: 0.05, category: "memory" },
  { name: "memory_save", label: "Save memory", description: "Store a fact in the employee's long-term memory", class: "reversible", credits: 0.05, category: "memory" },
  { name: "list_clients", label: "List clients", description: "List clients and projects from master data", class: "reversible", credits: 0.05, category: "clients" },
  { name: "get_client", label: "Get client", description: "Read one client with contacts and projects", class: "reversible", credits: 0.05, category: "clients" },
  { name: "list_invoices", label: "List invoices", description: "Read the invoice ledger (numbers, totals, status, due dates) and the company's invoice prefix", class: "reversible", credits: 0.05, category: "billing" },
  { name: "report_progress", label: "Report progress", description: "Report how much of the current task is done (0–100%) with a short note; granted automatically in tasks", class: "reversible", credits: 0, category: "tasks", implicit: "task" },
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
  { name: "request_revision", label: "Request revision", description: "Team lead: send a subtask back with feedback (at most twice per subtask)", class: "reversible", credits: 0.05, category: "team" },
  { name: "finish_review", label: "Finish review", description: "Division head: end the review of the subtasks with a verdict, accept (with notes) or fail (what is missing)", class: "reversible", credits: 0, category: "team" },
  { name: "retry_subtask", label: "Retry subtask", description: "Team lead: run a failed subtask again (bounded retries)", class: "reversible", credits: 0.05, category: "team" },
  { name: "reassign_subtask", label: "Reassign subtask", description: "Team lead: give a failed subtask to another team member", class: "reversible", credits: 0.05, category: "team" },
  { name: "handoff_to_division", label: "Hand off to division", description: "Division head: hand work over to another division as a new task (deliverables passed as data)", class: "reversible", credits: 0.05, category: "team" },
  { name: "message_teammate", label: "Message teammate", description: "Send a structured message to another employee", class: "reversible", credits: 0.05, category: "team" },
  { name: "ask_teammate", label: "Ask a colleague", description: "Chat: bring a colleague into this chat to help; they reply right after you (granted automatically in chats)", class: "reversible", credits: 0.02, category: "team" },
  { name: "send_email", label: "Send email", description: "Send an email via workspace SMTP", class: "irreversible", credits: 1, category: "comms" },
  { name: "send_invoice", label: "Send invoice", description: "Email an invoice PDF to a client", class: "irreversible", credits: 1, category: "billing" },
  { name: "git_push", label: "Push branch", description: "Workspace mode: push your committed work to agent/<task> on the remote (the platform pushes after approval)", class: "irreversible", credits: 0.5, category: "code" },
  { name: "create_pull_request", label: "Open pull request", description: "Workspace mode: open a pull/merge request from your branch (after approval)", class: "irreversible", credits: 0.5, category: "code" },
  { name: "list_apps", label: "List apps", description: "Workspace mode: the workspace's apps (preview URL, status, repository, branch, the version that runs) so you know which app to preview", class: "reversible", credits: 0.02, category: "code" },
  { name: "request_release", label: "Propose LIVE release", description: "Workspace mode: propose releasing a preview version that already ran to the app's LIVE site (only an Owner can approve it)", class: "irreversible", credits: 0.5, category: "code" },
  { name: "request_preview", label: "Publish preview", description: "Workspace mode: publish the branch you pushed (git_push) as a preview of an app at its URL (the platform deploys after approval)", class: "irreversible", credits: 0.5, category: "code" },
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
  /** exact recipient addresses (case-insensitive) */
  recipients: z.array(z.string()).optional(),
  /** recipients registered on the payload's client (main email or a contact) are allowed */
  clientContactsOnly: z.boolean().optional(),
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
  scope?: {
    recipients?: string[];
    clientId?: string | null;
    amount?: number;
    /** lower-cased addresses on file for scope.clientId (main email + contacts), looked up by the caller */
    clientRecipients?: string[];
  };
}

export function effectiveAutonomy(toolName: string, employeeAutonomy: AutonomyLevel, permissions: ToolPermission[]): AutonomyLevel {
  const p = matchToolPermission(toolName, permissions);
  return p?.autonomy ?? employeeAutonomy;
}

/** Bare lower-cased address for display: `"Ana" <Ana@X.com>` → `ana@x.com`. Not a validator: the gate uses parseSingleAddress. */
export function normalizeEmail(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1]! : raw).trim().toLowerCase();
}

const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Exactly one address, lower-cased: `local@domain` or `Display Name <local@domain>` (the name without `<>,;@`).
 * Anything a mailer could read as several addresses (`,` `;` a newline, a second `@` or `<`) is null, so
 * `"evil@x.com, <ok@allowed.com>"` never passes as ok@allowed.com.
 */
export function parseSingleAddress(raw: string): string | null {
  if (typeof raw !== "string" || /[,;\r\n]/.test(raw)) return null;
  const s = raw.trim();
  const named = /^([^<>,;@]*)<([^<>]*)>$/.exec(s);
  const addr = (named ? named[2]! : s).trim();
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@")) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
  return addr.toLowerCase();
}

/** A payload recipient: one address per entry (see parseSingleAddress). */
export const singleAddressSchema = z.string().refine((s) => parseSingleAddress(s) !== null, {
  message: "Each recipient must be a single email address (name@domain or Name <name@domain>)",
});

export function allowListMatches(entry: AllowListEntry, scope: GateInput["scope"]): boolean {
  // recipient rules (any configured): every recipient must satisfy at least one of them. A rule configured with only
  // blank or invalid values matches nobody (it never widens to "any recipient").
  const domains = entry.recipientDomains.map((d) => d.toLowerCase().trim().replace(/^@/, "")).filter(Boolean);
  const exact = (entry.recipients ?? []).map(parseSingleAddress).filter((x): x is string => !!x);
  const contactsOnly = entry.clientContactsOnly === true;
  if (entry.recipientDomains.length > 0 || (entry.recipients?.length ?? 0) > 0 || contactsOnly) {
    const recips = (scope?.recipients ?? []).map(parseSingleAddress);
    // a recipient that is not exactly one address (e.g. "evil@x.com, <ok@allowed.com>") matches nothing
    if (recips.length === 0 || recips.some((r) => r === null)) return false;
    const known = new Set((scope?.clientRecipients ?? []).map(parseSingleAddress).filter((x): x is string => !!x));
    const ok = (recips as string[]).every((r) => {
      const domain = r.split("@")[1]!;
      if (domains.includes(domain)) return true;
      if (exact.includes(r)) return true;
      return contactsOnly && !!scope?.clientId && known.has(r);
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
  | { type: "quota.resumed" }
  | { type: "task.progress"; taskId: string; progress: number; note: string }
  | { type: "outbox.updated"; emailId: string | null; status: OutboxStatus }
  | { type: "invoice.updated"; invoiceId: string; clientId: string; status: InvoiceStatus }
  | { type: "server.updated"; serverId: string; status: ServerStatus }
  | { type: "app.updated"; appId: string; status: AppStatus; environmentId?: string }
  | { type: "release.updated"; releaseId: string; appId: string; status: ReleaseStatus; step: ReleaseStep | null };

export interface StepDTO {
  id: string;
  taskId: string | null;
  employeeId: string | null;
  /** who acted when it was not the run's employee: a division member working as a subagent in the code lead's run */
  actorEmployeeId?: string | null;
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

/** Text kept in both UI languages (division SOPs, names). */
export interface Bilingual {
  en: string;
  id: string;
}

/**
 * How a member works in a division (UI: "Divisi"): member = takes subtasks from the head; subagent = works inside
 * the code lead's sandbox run (one branch per task). The head and the code lead are set on the division itself.
 */
export const TEAM_MEMBER_ROLES = ["member", "subagent"] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

/** Runs of one division at the same time (head, members, code lead), enforced across workers. */
export const DIVISION_MAX_PARALLEL = 10;

export const PROJECT_HEALTH = ["on_track", "at_risk", "late"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];

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
  /** assistant messages: the colleague (employee id) who brought this responder in with ask_teammate */
  askedBy?: string;
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

/** A file on a chat message: a knowledge-base document (documentId) or an image the model sees (imageId + mime). */
export interface ChatAttachment {
  name: string;
  size: number;
  documentId?: string;
  imageId?: string;
  mime?: string;
}
/** As stored on the message row: images also keep where the file lives (server-only, never sent to a client). */
export type StoredChatAttachment = ChatAttachment & { storagePath?: string };
/** Images a chat message can carry, by sniffed type, with the extension they are stored under. */
export const CHAT_IMAGE_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as const;
export type ChatImageType = keyof typeof CHAT_IMAGE_TYPES;
/** Per image (the model's own limit for one image is 5 MB). */
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Files (images and documents together) on one chat message. */
export const CHAT_ATTACHMENTS_MAX = 5;
/** The client-facing view of a stored attachment. */
export function publicAttachment({ storagePath: _path, ...a }: StoredChatAttachment): ChatAttachment {
  return a;
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
  attachments?: ChatAttachment[];
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

/** set by the web while an app's remove job is queued (one at a time); cleared by the worker when the job ends */
export function appRemoveLockKey(appId: string, namespace = ""): string {
  return `${namespace ? `${namespace}:` : ""}wfos:app-remove:${appId}`;
}

// ---------------------------------------------------------------------------
// Queue job payloads
// ---------------------------------------------------------------------------

export const QUEUE_RUNS = "wfos-runs";
export const QUEUE_ACTIONS = "wfos-actions";
export const QUEUE_INGEST = "wfos-ingest";
export const QUEUE_MISC = "wfos-misc";
/** app deploys and app start/stop/remove: one job at a time per worker, so one build at a time per server */
export const QUEUE_DEPLOYS = "wfos-deploys";

export type RunJob =
  | { kind: "task"; taskId: string; workspaceId: string; resumeNote?: string }
  | { kind: "chat"; conversationId: string; messageId: string; workspaceId: string }
  /** answer this user message again: a new assistant sibling below it, which becomes the active leaf */
  | { kind: "chat_regenerate"; conversationId: string; userMessageId: string; workspaceId: string };

export type ActionJob =
  | { kind: "execute_approval"; approvalId: string; workspaceId: string }
  | { kind: "rejected_approval"; approvalId: string; workspaceId: string };
export type DeployJob =
  /** run this queued release (a deploy, or a rollback: trigger "rollback") */
  | { kind: "release"; releaseId: string; workspaceId: string }
  /** republish = write the nginx site again (new preview password / access mode) on a running app, no restart */
  /** environmentId: the environment to act on; remove without it removes the whole app (every environment) */
  | { kind: "app_action"; appId: string; workspaceId: string; environmentId?: string; action: "stop" | "start" | "remove" | "republish"; userId: string | null; reason?: string }
  /** live/preview database: take a backup now (manual), or restore one (a pre_restore backup is taken first) */
  | { kind: "db_backup"; appId: string; workspaceId: string; environmentId: string; userId: string | null; backupKind: "manual" | "daily" }
  | { kind: "db_restore"; appId: string; workspaceId: string; environmentId: string; backupId: string; userId: string };
export type IngestJob = { kind: "ingest"; documentId: string; workspaceId: string };
export type MiscJob =
  | { kind: "replay"; replayId: string; workspaceId: string }
  | { kind: "demo"; workspaceId: string; userId: string }
  | { kind: "routine_run"; routineId: string; workspaceId: string; userId?: string }
  /** a person retries a failed outbox email: the worker sends its stored payload again (policy still applies) */
  | { kind: "outbox_resend"; emailId: string; workspaceId: string; userId: string }
  /** refresh a repository's mirror and record pushed agent work found already in its default branch */
  | { kind: "merge_scan"; workspaceId: string; repositoryId: string }
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
  /** approval notices: when the notice was first held because the employee was still working (ms since epoch) */
  heldSince?: number;
};

/** Task statuses in which a pending approval of the task cannot be decided yet: the employee is still working. */
export const APPROVAL_UNDECIDABLE_TASK_STATUSES = ["RUNNING", "QUEUED"] as const;

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
  // an emoji (older data) or the bot avatar choice, "bot:<shape>/<colour>/<expression>"
  avatar: z.string().max(64).default("🤖"),
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
  /** one line of expertise: how a division head or code lead picks this employee */
  specialty: z.string().max(200).default(""),
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
export type RepositoryProvider = "github" | "gitlab" | "git";

/**
 * Why `url` is not a clone URL of a repository at that provider, or null. GitHub: https://github.com/<owner>/<repo>
 * (optionally .git); GitLab: a group and a project at least; other git: at least one path segment. Catches e.g. a
 * website address pasted in place of the repository's.
 */
export function repositoryUrlProblem(provider: RepositoryProvider, url: string): string | null {
  if (!/^https:\/\/[^@\s]+$/.test(url)) return "Use an https clone URL without credentials";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Not a valid URL";
  }
  if (u.search || u.hash) return "A clone URL has no ?query or #fragment";
  const segments = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (provider === "github") {
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return "A GitHub repository lives at https://github.com/<owner>/<repository>";
    if (segments.length !== 2) return "Use https://github.com/<owner>/<repository>.git";
  } else if (provider === "gitlab") {
    if (segments.length < 2) return "Use https://<gitlab host>/<group>/<project>.git";
  } else if (segments.length < 1) {
    return "This is a website address, not a repository: add the repository's path";
  }
  return null;
}

const repositoryNameSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, "letters, digits, dot, dash, underscore");
const repositoryBranchSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/);
const repositoryTokenSchema = z.string().trim().min(10).max(500);

/** the URL itself is checked with repositoryUrlProblem by the route (error code repository_url_invalid) */
export const repositoryInputSchema = z.object({
  name: repositoryNameSchema,
  provider: z.enum(["github", "gitlab", "git"]),
  url: z.url().trim(),
  defaultBranch: repositoryBranchSchema.default("main"),
  token: repositoryTokenSchema.optional(),
});

/** change a connected repository (its provider stays); token: a new one, or null to remove it */
export const repositoryUpdateSchema = z.object({
  url: z.url().trim().optional(),
  defaultBranch: repositoryBranchSchema.optional(),
  token: repositoryTokenSchema.nullable().optional(),
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
/** { [kind]: { [channel]: boolean } }; anything missing takes notificationDefault. */
export type NotificationChannelPrefs = Partial<Record<NotificationKind, Partial<Record<NotificationChannel, boolean>>>>;
/** Kinds too frequent for an inbox: email stays off for them until a person switches it on. */
const EMAIL_OFF_BY_DEFAULT: readonly NotificationKind[] = ["task_done", "chat_reply"];
/** What a kind × channel is when the person never set it: on, except email for the chatty kinds. */
export function notificationDefault(kind: NotificationKind, channel: NotificationChannel): boolean {
  return !(channel === "email" && EMAIL_OFF_BY_DEFAULT.includes(kind));
}
/** Whether this person gets `kind` on `channel`: their own switch, else the default. */
export function notificationEnabled(prefs: NotificationChannelPrefs | null | undefined, kind: NotificationKind, channel: NotificationChannel): boolean {
  return prefs?.[kind]?.[channel] ?? notificationDefault(kind, channel);
}

export const CLIENT_STATUSES = ["active", "prospect", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
/** suggested contact roles; `role` stays free text so older contacts keep theirs */
export const CONTACT_ROLES = ["project", "billing", "director", "technical", "other"] as const;
export const CONTACT_RECEIVES = ["status", "minutes", "invoice"] as const;
export type ContactReceives = (typeof CONTACT_RECEIVES)[number];

export const clientContactSchema = z.object({
  name: z.string().max(160),
  email: z.email().or(z.literal("")),
  role: z.string().max(60).default(""),
  phone: z.string().max(40).default(""),
  /** which mail this contact should get: status reports, meeting minutes, invoices */
  receives: z.object({ status: z.boolean().default(false), minutes: z.boolean().default(false), invoice: z.boolean().default(false) }).default({ status: false, minutes: false, invoice: false }),
});
export type ClientContact = z.infer<typeof clientContactSchema>;
/** as stored in clients.contacts: rows written before 0025 lack phone/receives */
export type StoredClientContact = z.input<typeof clientContactSchema>;

export const clientInputSchema = z.object({
  name: z.string().min(1).max(160),
  /** short code (e.g. GOB), unique per workspace; "" = none */
  code: z
    .string()
    .regex(/^([A-Z0-9][A-Z0-9-]{1,11})?$/)
    .default(""),
  website: z.string().max(300).default(""),
  industry: z.string().max(200).default(""),
  email: z.email().or(z.literal("")).default(""),
  contacts: z.array(clientContactSchema).max(50).default([]),
  notes: z.string().max(5000).default(""),
  currency: z.string().default("IDR"),
  status: z.enum(CLIENT_STATUSES).default("active"),
  legalName: z.string().max(200).default(""),
  taxId: z.string().max(40).default(""),
  address: z.string().max(1000).default(""),
  phone: z.string().max(40).default(""),
});

/** Contacts as stored (rows from before 0025 lack phone/receives): always read through this. */
export function parseContacts(raw: unknown): ClientContact[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const r = clientContactSchema.safeParse(c);
    return r.success ? [r.data] : [];
  });
}

/** Lower-cased addresses on file for a client: its main email plus every contact (optionally only those receiving `kind`). */
export function clientRecipientAddresses(c: { email: string; contacts: unknown }, kind?: ContactReceives): string[] {
  const contacts = parseContacts(c.contacts).filter((x) => x.email && (!kind || x.receives[kind]));
  const out = contacts.map((x) => normalizeEmail(x.email));
  if (!kind && c.email) out.unshift(normalizeEmail(c.email));
  return [...new Set(out)];
}

/** Company profile (workspaces.settings.company): printed on invoices, read by agents for numbering. */
export const companyProfileSchema = z.object({
  legalName: z.string().max(200).default(""),
  address: z.string().max(1000).default(""),
  taxId: z.string().max(40).default(""),
  phone: z.string().max(40).default(""),
  email: z.email().or(z.literal("")).default(""),
  bankName: z.string().max(120).default(""),
  bankAccount: z.string().max(60).default(""),
  bankHolder: z.string().max(160).default(""),
  invoicePrefix: z.string().max(20).regex(/^[A-Za-z0-9/._-]*$/).default("INV"),
  invoiceFooter: z.string().max(1000).default(""),
  defaultTaxPercent: z.number().min(0).max(100).default(0),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export function parseCompanyProfile(settings: unknown): CompanyProfile {
  const raw = settings && typeof settings === "object" ? (settings as { company?: unknown }).company : undefined;
  const r = companyProfileSchema.safeParse(raw ?? {});
  return r.success ? r.data : companyProfileSchema.parse({});
}

/** `${prefix}-${year}-${seq:4}`, e.g. INV-2026-0007. */
export function formatInvoiceNumber(prefix: string, year: number, seq: number): string {
  return `${prefix ? `${prefix}-` : ""}${year}-${String(seq).padStart(4, "0")}`;
}

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const invoiceStatusPatchSchema = z.object({ status: z.enum(INVOICE_STATUSES) });

export const BILLING_PERIODS = ["monthly", "yearly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
export const recurringBillingInputSchema = z
  .object({
    clientId: z.string().uuid(),
    projectId: z.string().uuid().nullable().default(null),
    description: z.string().min(1).max(300),
    amount: z.number().positive(),
    taxPercent: z.number().min(0).max(100).default(0),
    dueDays: z.number().int().min(0).max(120).default(14),
    period: z.enum(BILLING_PERIODS).default("monthly"),
    dayOfMonth: z.number().int().min(1).max(28).default(1),
    startMonth: z.number().int().min(1).max(12).nullable().default(null),
    active: z.boolean().default(true),
    employeeId: z.string().uuid().nullable().default(null),
    recipients: z.array(z.email()).max(20).default([]),
  })
  .refine((v) => v.period !== "yearly" || v.startMonth !== null, { message: "A yearly billing needs its month", path: ["startMonth"] });

/** The billing period a run at `date` (in tz) covers: YYYY-MM (monthly) or YYYY (yearly). */
export function billingPeriodOf(period: BillingPeriod, ymd: { year: number; month: number }): string {
  return period === "yearly" ? String(ymd.year) : `${ymd.year}-${String(ymd.month).padStart(2, "0")}`;
}
/** Cron expression for a recurring billing: 08:00 on its day (yearly: in its month). */
export function billingCron(r: { period: BillingPeriod; dayOfMonth: number; startMonth: number | null }): string {
  return r.period === "yearly" ? `0 8 ${r.dayOfMonth} ${r.startMonth ?? 1} *` : `0 8 ${r.dayOfMonth} * *`;
}

// ---- outbox ----
export const OUTBOUND_EMAIL_KINDS = ["email", "invoice"] as const;
export type OutboundEmailKind = (typeof OUTBOUND_EMAIL_KINDS)[number];
export type OutboundEmailStatus = "sending" | "sent" | "failed";
/** approval = a person approved it; allow_list = an Owner allow-list rule let it run; resend = a person retried a failed one */
export type OutboundEmailTrigger = "approval" | "allow_list" | "resend";
/** What the outbox shows: attempts (sending/sent/failed) merged with proposals still in approvals. */
export type OutboxStatus = "pending_approval" | "rejected" | "expired" | OutboundEmailStatus;

/** Outgoing agent email policy (workspaces.settings.email). Notifications are not affected. */
export const emailPolicySchema = z.object({
  paused: z.boolean().default(false),
  dailyLimit: z.number().int().min(1).max(10000).default(100),
});
export type EmailPolicy = z.infer<typeof emailPolicySchema>;
export function parseEmailPolicy(settings: unknown): EmailPolicy {
  const raw = settings && typeof settings === "object" ? (settings as { email?: unknown }).email : undefined;
  const r = emailPolicySchema.safeParse(raw ?? {});
  return r.success ? r.data : emailPolicySchema.parse({});
}

/** SMTP presets: fill host/port/secure (secure=true is implicit TLS on 465; false uses STARTTLS on 587). */
export const SMTP_PRESETS = [
  { key: "google", host: "smtp.gmail.com", port: 465, secure: true, userHint: "you@yourdomain.com" },
  { key: "microsoft", host: "smtp.office365.com", port: 587, secure: false, userHint: "you@yourdomain.com" },
  { key: "zoho", host: "smtp.zoho.com", port: 465, secure: true, userHint: "you@yourdomain.com" },
  { key: "ses", host: "email-smtp.ap-southeast-1.amazonaws.com", port: 587, secure: false, userHint: "SMTP username (AKIA…)" },
  { key: "mailgun", host: "smtp.mailgun.org", port: 587, secure: false, userHint: "postmaster@mg.yourdomain.com" },
  { key: "sendgrid", host: "smtp.sendgrid.net", port: 587, secure: false, userHint: "apikey" },
] as const;
export type SmtpPresetKey = (typeof SMTP_PRESETS)[number]["key"];

// ---- task progress ----
export const progressInputSchema = z.object({
  percent: z.number().int().min(0).max(100),
  note: z.string().max(200).default(""),
});

export const projectInputSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(160),
  status: z.string().default("active"),
  description: z.string().max(5000).default(""),
  hourlyRate: z.number().nonnegative().default(0),
  deadline: z.iso.date().nullable().optional(),
  progress: z.number().int().min(0).max(100).default(0),
  /** division responsible: the project's tasks without an assignee go to it */
  teamId: z.string().uuid().nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  nextMilestone: z.string().max(500).default(""),
  health: z.enum(PROJECT_HEALTH).default("on_track"),
  nextStep: z.string().max(1000).default(""),
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

const bilingualSchema = (max: number) => z.object({ en: z.string().max(max).default(""), id: z.string().max(max).default("") });

/** A division (stored in `teams`). Members are listed with their role; the head and code lead must be members too. */
export const teamInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    key: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,39}$/)
      .nullable()
      .optional(),
    description: z.string().max(2000).default(""),
    leadId: z.string().uuid().nullable(),
    codeLeadId: z.string().uuid().nullable().default(null),
    members: z
      .array(z.object({ employeeId: z.string().uuid(), role: z.enum(TEAM_MEMBER_ROLES).default("member") }))
      .max(100)
      .default([]),
    responderMode: z.enum(TEAM_RESPONDER_MODES).default("lead"),
    sop: bilingualSchema(20000).default({ en: "", id: "" }),
    color: z
      .string()
      .regex(/^(#[0-9a-fA-F]{6})?$/)
      .default(""),
    maxParallel: z.number().int().min(1).max(DIVISION_MAX_PARALLEL).default(1),
    dailyBudget: z.number().nonnegative().max(1_000_000).nullable().default(null),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .superRefine((d, ctx) => {
    const err = divisionStructureError(d);
    if (err) ctx.addIssue({ code: "custom", message: err });
  });
export type TeamInput = z.infer<typeof teamInputSchema>;

/**
 * The rules a division's structure must satisfy (also checked server-side against the database):
 * no duplicate members; the head and the code lead are members with role "member"; subagents need a code lead.
 */
export function divisionStructureError(d: { leadId: string | null; codeLeadId: string | null; members: { employeeId: string; role: TeamMemberRole }[] }): string | null {
  const ids = d.members.map((m) => m.employeeId);
  if (new Set(ids).size !== ids.length) return "An employee is listed twice in this division.";
  const roleOf = (id: string) => d.members.find((m) => m.employeeId === id)?.role;
  if (d.leadId && roleOf(d.leadId) !== "member") return "The head must be a member of the division (not a subagent).";
  if (d.codeLeadId && roleOf(d.codeLeadId) !== "member") return "The code lead must be a member of the division (not a subagent).";
  if (d.codeLeadId && d.codeLeadId === d.leadId) return "The head and the code lead must be different people.";
  if (!d.codeLeadId && d.members.some((m) => m.role === "subagent")) return "Subagents work inside the code lead's run: choose a code lead first.";
  return null;
}

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "edit_approve", "reject"]),
  editedPayload: z.record(z.string(), z.unknown()).optional(),
  feedback: z.string().max(5000).optional(),
});

// ---------------------------------------------------------------------------
// Payload shapes for irreversible actions (rendered in the Approvals inbox)
// ---------------------------------------------------------------------------

export const emailPayloadSchema = z.object({
  to: z.array(singleAddressSchema).min(1),
  cc: z.array(singleAddressSchema).default([]),
  subject: z.string().min(1),
  body: z.string().min(1),
  html: z.boolean().default(false),
  clientId: z.string().nullable().optional(),
});
export type EmailPayload = z.infer<typeof emailPayloadSchema>;

export const invoiceLineSchema = z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() });
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export const invoicePayloadSchema = z.object({
  clientId: z.string(),
  invoiceNumber: z.string(),
  currency: z.string().default("IDR"),
  lines: z.array(invoiceLineSchema).min(1),
  /** VAT/PPN on the subtotal, e.g. 11 */
  taxPercent: z.number().min(0).max(100).default(0),
  dueDate: z.string(),
  notes: z.string().default(""),
  to: z.array(singleAddressSchema).default([]),
  subject: z.string().default(""),
  body: z.string().default(""),
  projectId: z.string().nullable().optional(),
  /** set by the recurring-billing scheduler: the ledger row this approval sends */
  invoiceId: z.string().nullable().optional(),
});
export type InvoicePayload = z.infer<typeof invoicePayloadSchema>;

export function invoiceSubtotal(p: Pick<InvoicePayload, "lines">): number {
  return p.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
}

/** Tax rounded to the currency's minor unit (IDR: whole rupiah). */
export function invoiceTax(p: Pick<InvoicePayload, "lines" | "currency"> & { taxPercent?: number }): number {
  const raw = (invoiceSubtotal(p) * (p.taxPercent ?? 0)) / 100;
  return p.currency === "IDR" ? Math.round(raw) : Math.round(raw * 100) / 100;
}

/** Amount due: subtotal + tax. */
export function invoiceTotal(p: Pick<InvoicePayload, "lines"> & { currency?: string; taxPercent?: number }): number {
  return invoiceSubtotal(p) + invoiceTax({ lines: p.lines, currency: p.currency ?? "IDR", taxPercent: p.taxPercent });
}

export const webhookPayloadSchema = z.object({ channel: z.string().default("default"), text: z.string().min(1) });

export function formatCredits(n: number): string {
  return n < 1 ? n.toFixed(3) : n.toFixed(2);
}
export * from "./mcp-oauth";
export * from "./package";

// ---- app servers (Phase A of the app factory) ----
export const SERVER_ROLES = ["dev", "live"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];
/** pending = registered, not verified · ready = verified and probed · error = last check failed */
export const SERVER_STATUSES = ["pending", "ready", "error"] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

/** The helper version this platform needs on a server; an older one asks the Owner to re-run prepare.sh. */
export const WFOS_HELPER_VERSION = 4;

/** What `wfos-app-helper info` reports (JSON on stdout). */
export const serverInfoSchema = z.object({
  helperVersion: z.number().int(),
  os: z.string().default(""),
  node: z.string().default(""),
  pnpm: z.string().default(""),
  nginx: z.boolean().default(false),
  certbot: z.boolean().default(false),
  /** port of the apps-only Postgres cluster, null when not installed */
  postgresPort: z.number().int().nullable().default(null),
  diskFreeMb: z.number().default(0),
  memTotalMb: z.number().default(0),
  memAvailableMb: z.number().default(0),
  baseDomain: z.string().default(""),
  /** helper 2+: systemd version, whether the apps firewall table is loaded, where apps live */
  systemd: z.number().int().nullable().default(null),
  firewall: z.boolean().nullable().default(null),
  appsRoot: z.string().default(""),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
export const serverInputSchema = z.object({
  name: z.string().min(1).max(60),
  /** hostname or IP literal */
  host: z.string().min(1).max(253).refine((h) => HOSTNAME_RE.test(h) || /^[0-9.]+$/.test(h) || /^[0-9a-fA-F:]+$/.test(h), "Invalid host"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default("wfos-apps"),
  role: z.enum(SERVER_ROLES).default("dev"),
  baseDomain: z.string().min(3).max(200).refine((d) => HOSTNAME_RE.test(d) && d.includes("."), "Invalid domain").transform((d) => d.toLowerCase()),
  maxRunningApps: z.number().int().min(1).max(50).default(3),
});
export type ServerInput = z.infer<typeof serverInputSchema>;
/** confirm the fingerprint the Owner compared on the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) */
export const serverVerifySchema = z.object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/) });

// ---- apps and releases (Phase A2 of the app factory) ----
/** new = created, never deployed · deploying · running · stopped (by a person or auto-stop) · failed (no version runs) */
export const APP_STATUSES = ["new", "deploying", "running", "stopped", "failed"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
/**
 * queued → deploying → deployed | failed (the previous version, if any, kept running) | rolled_back (the new version
 * was switched on, failed its checks, and the previous version runs again) · superseded = a later release replaced it
 */
export const RELEASE_STATUSES = ["queued", "deploying", "deployed", "failed", "rolled_back", "superseded"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const RELEASE_TRIGGERS = ["approval", "manual", "rollback"] as const;
export type ReleaseTrigger = (typeof RELEASE_TRIGGERS)[number];
/** a deploy's steps, in order (a release reports the one it is on) */
export const RELEASE_STEPS = ["prepare", "upload", "unpack", "env", "database", "install", "build", "backup", "migrate", "activate", "health", "publish", "public_check", "cleanup"] as const;
export type ReleaseStep = (typeof RELEASE_STEPS)[number];
/** things the approval card / release page warns about (computed against the release that runs now) */
export const RELEASE_WARNINGS = ["first_publish", "manifest_changed", "scripts_changed", "new_database", "destructive_migration", "public_access"] as const;
export type ReleaseWarning = (typeof RELEASE_WARNINGS)[number];
export const APP_ACCESS_MODES = ["password", "public"] as const;
export type AppAccessMode = (typeof APP_ACCESS_MODES)[number];

/** ports the platform hands out per server (unique per server in the DB; the helper refuses others) */
export const APP_PORT_MIN = 4100;
export const APP_PORT_MAX = 4499;
/** a preview with no new release for this many days is stopped (one click starts it again) */
export const APP_IDLE_STOP_DAYS = 14;
/** releases kept on the server per app (older release folders are removed) */
export const APP_RELEASES_KEPT = 3;
export const APP_DB_BACKUPS_KEPT = 7;
/** live: daily database backups kept on the server (pre-migration backups are kept APP_DB_BACKUPS_KEPT) */
export const APP_LIVE_DAILY_BACKUPS_KEPT = 14;
/** live blue-green: the second slot listens on port + APP_ALT_PORT_OFFSET (4500..4899) */
export const APP_ALT_PORT_OFFSET = 400;
/** live blue-green: the old slot keeps running this long after the switch, for an instant rollback */
export const APP_LIVE_GRACE_SECONDS = 120;
export const APP_SLOTS = ["blue", "green"] as const;
export type AppSlot = (typeof APP_SLOTS)[number];
export const APP_BACKUP_KINDS = ["pre_migrate", "daily", "manual", "pre_restore"] as const;
export type AppBackupKind = (typeof APP_BACKUP_KINDS)[number];
export interface AppBackupDTO {
  id: string;
  environmentId: string;
  name: string;
  kind: AppBackupKind;
  sizeBytes: number | null;
  /** where it lives: "server" (on the app server only) or "offsite" (also copied out) */
  offsite: boolean;
  releaseId: string | null;
  createdAt: string;
  createdByName: string | null;
}
/** an Owner restores a live (or preview) database from one of its backups: the environment's domain typed to confirm */
export const appRestoreSchema = z.object({ backupId: z.uuid(), confirm: z.string().min(1).max(253) });

/** subdomains an app may never take (also refused by the helper) */
export const RESERVED_APP_SLUGS = ["www", "api", "app", "apps", "admin", "mail", "preview", "static", "assets", "cdn", "status"] as const;
export const APP_SLUG_RE = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;
export const appSlugSchema = z
  .string()
  .regex(APP_SLUG_RE, "Use 2–30 lowercase letters, digits and dashes, starting with a letter")
  .refine((s) => !s.includes("--") && !(RESERVED_APP_SLUGS as readonly string[]).includes(s), "This name is reserved")
  // <slug>-live is the live environment's instance name on a server (appInstanceName)
  .refine((s) => !s.endsWith("-live") && !/-live-(blue|green)$/.test(s), "Names ending in -live (or -live-blue / -live-green) are reserved for live environments");

/** a single shell command line from the manifest (run as the app's own user inside its sandbox) */
const manifestCommand = z
  .string()
  .min(1)
  .max(500)
  .refine((c) => !/[\u0000-\u001f\u007f]/.test(c), "One line, no control characters");

/**
 * `wfos-app.json` at the root of the app's repository. Strict: unknown keys are refused, so a typo never silently
 * turns into a default.
 */
export const appManifestSchema = z
  .object({
    /** the only stack in Phase A */
    type: z.literal("nextjs"),
    install: manifestCommand.default("pnpm install --frozen-lockfile"),
    build: manifestCommand.default("pnpm build"),
    /** must listen on $HOST:$PORT (127.0.0.1) */
    start: manifestCommand.default("pnpm start -H 127.0.0.1 -p $PORT"),
    /** runs before the new version starts, after a database backup; omitted = no migrations */
    migrate: manifestCommand.optional(),
    /** GET path that answers 2xx when the app is up */
    health: z.string().regex(/^\/[A-Za-z0-9._\/-]{0,200}$/).default("/api/health"),
    /** true = the platform creates a PostgreSQL database and sets DATABASE_URL */
    database: z.boolean().default(false),
    /** MB of memory for the running app (the build gets its own, larger limit) */
    memoryMb: z.number().int().min(256).max(1024).default(512),
    /**
     * expand = the migration only adds (tables, nullable columns, indexes): it runs while the old version keeps
     * serving (live: no downtime). breaking (default) = live shows a maintenance page while it migrates.
     * A release that claims "expand" but whose migration files drop/rename/narrow anything is refused.
     */
    migrations: z.enum(["expand", "breaking"]).default("breaking"),
    /**
     * C10: makes (or updates) one test account per role on the PREVIEW after each release, with the shared password
     * in $WFOS_TEST_PASSWORD, and prints them as JSON on its last line (see testUsersOutputSchema). Never runs on live.
     */
    testUsers: manifestCommand.optional(),
  })
  .strict();
export type AppManifest = z.infer<typeof appManifestSchema>;

/** at most this many test accounts per environment */
export const TEST_USERS_MAX = 20;
/** one test account as the app's testUsers script prints it (no password: the shared one, or a manual row's own) */
export const testUserSchema = z
  .object({
    /** stable key of the role in the app (admin, requester, approver…) */
    role: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    label: z.string().trim().min(1).max(80),
    username: z.string().trim().min(1).max(200),
    /** base32 TOTP key when the account has two-factor on */
    totp: z
      .string()
      .transform((v) => v.replace(/\s+/g, "").toUpperCase())
      .pipe(z.string().regex(/^[A-Z2-7]{16,128}=*$/))
      .optional(),
    /** where its sign-in page is */
    loginPath: z.string().regex(/^\/[A-Za-z0-9._~\/?=&%-]{0,200}$/).default("/"),
    /** this account sees everything (a tour, a deck) */
    viewAll: z.boolean().default(false),
    note: z.string().max(500).default(""),
  })
  .strict();
export type TestUser = z.infer<typeof testUserSchema>;
export const testUsersOutputSchema = z.object({ users: z.array(testUserSchema).min(1).max(TEST_USERS_MAX), note: z.string().max(500).optional() }).strict();
export type TestUsersOutput = z.infer<typeof testUsersOutputSchema>;

/**
 * The accounts in a testUsers run's output: the LAST line that is a JSON object (the script may log before it).
 * Roles must be unique. The raw output is never logged (it carries TOTP keys).
 */
export function parseTestUsersOutput(out: string): { ok: true; value: TestUsersOutput } | { ok: false; error: string } {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"));
  const last = lines.at(-1);
  if (!last) return { ok: false, error: "the testUsers command printed no JSON line ({\"users\": [...]})" };
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    return { ok: false, error: "the last JSON line of testUsers is not valid JSON" };
  }
  const parsed = testUsersOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `testUsers output: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 400)}` };
  const roles = parsed.data.users.map((u) => u.role);
  const dup = roles.find((r, i) => roles.indexOf(r) !== i);
  if (dup) return { ok: false, error: `testUsers output: role "${dup}" appears twice` };
  return { ok: true, value: parsed.data };
}
export const APP_MANIFEST_FILE = "wfos-app.json";

/** env names the platform sets itself (a person cannot override them) */
export const APP_RESERVED_ENV = ["PORT", "HOST", "NODE_ENV", "APP_URL", "APP_SECRET", "APP_VERSION", "APP_DATA_DIR", "DATABASE_URL", "WFOS_TEST_PASSWORD"] as const;
/** names the server's helper refuses (they would steer the sandbox or the build): never accepted from a person */
export function isForbiddenAppEnv(name: string): boolean {
  return (APP_RESERVED_ENV as readonly string[]).includes(name) || ["HOME", "PATH", "NPM_CONFIG_STORE_DIR", "XDG_CACHE_HOME"].includes(name) || /^(LD_|COREPACK_)/.test(name);
}
export const APP_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** extra env for an app; values are stored encrypted and never shown again */
export const appEnvSchema = z
  .record(
    z.string().regex(APP_ENV_NAME_RE, "Use UPPER_CASE names"),
    z
      .string()
      .max(4000)
      .refine((v) => !/[\u0000\n\r]/.test(v), "One line per value"),
  )
  .refine((e) => Object.keys(e).length <= 50, "At most 50 variables")
  .refine((e) => !Object.keys(e).some(isForbiddenAppEnv), "This name is set by the platform");
export type AppEnv = z.infer<typeof appEnvSchema>;

const gitRef = z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/).refine((r) => !r.includes("..") && !r.startsWith("-"), "Invalid branch");
export const appInputSchema = z.object({
  name: z.string().min(1).max(80),
  slug: appSlugSchema,
  serverId: z.uuid(),
  repositoryId: z.uuid(),
  branch: gitRef.optional(),
  clientId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  accessMode: z.enum(APP_ACCESS_MODES).default("password"),
});
export type AppInput = z.infer<typeof appInputSchema>;
/** slug, server and repository are fixed once created */
export const appUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  branch: gitRef.optional(),
  clientId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  accessMode: z.enum(APP_ACCESS_MODES).optional(),
});
/** manual deploy: a branch (its head now) or an exact commit; neither = the app's branch */
export const appDeploySchema = z
  .object({ branch: gitRef.optional(), commit: z.string().regex(/^[0-9a-f]{40}$/).optional() })
  .refine((d) => !(d.branch && d.commit), "Give a branch or a commit, not both");

/** written by the worker as a release passes its irreversible points */
export interface ReleaseCheckpoint {
  /** the app's status when the release started (restored when it fails before activate) */
  appStatusBefore: AppStatus;
  /** the sha `current` pointed at before activate ("none" = first version) */
  previousSha?: string;
  /** `current` was switched to this release */
  activated?: boolean;
  /** the migration ran (dbBackup holds the backup to restore) */
  migrated?: boolean;
  /** live: the names this release published (domain + redirecting names), so a rollback can tell nothing moved */
  publishedNames?: string[];
  /** live blue-green: the slot this release was started in, and the slot that served before it */
  slot?: AppSlot;
  previousSlot?: AppSlot | null;
  /** live: the maintenance page was switched on for a breaking migration */
  maintenance?: boolean;
  /** live: the slot (or the B1 single unit) that keeps running after the switch, until graceUntil, for an instant rollback */
  graceSlot?: AppSlot | "legacy" | null;
  graceReleaseId?: string | null;
  graceUntil?: string | null;
  graceDone?: boolean;
}

/**
 * Approval payload of request_preview (Phase A3): the exact commit the Developer pushed to agent/<task>, and what
 * changes against the version that runs now. The executor re-checks that this commit is still the pushed head.
 */
export const requestPreviewPayloadSchema = z.object({
  appId: z.uuid(),
  appName: z.string(),
  url: z.string(),
  serverName: z.string(),
  repositoryId: z.uuid(),
  repository: z.string(),
  branch: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  commitSubject: z.string().nullable(),
  /** the commit that runs now (null: first preview) */
  currentCommit: z.string().nullable(),
  /** commits since currentCommit (or since the default branch on a first preview), newest first, capped */
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })).max(50),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })).max(300),
  filesTruncated: z.boolean(),
  warnings: z.array(z.enum(RELEASE_WARNINGS)),
  /** the validated wfos-app.json of that commit */
  manifest: appManifestSchema,
  summary: z.string().max(2000),
});
export type RequestPreviewPayload = z.infer<typeof requestPreviewPayloadSchema>;
// ---- environments (Phase B: live) ----
export const APP_ENVIRONMENT_KINDS = ["preview", "live"] as const;
export type AppEnvironmentKind = (typeof APP_ENVIRONMENT_KINDS)[number];
/** the helper's instance name of an environment: the slug for the preview, <slug>-live for the live one */
export function appInstanceName(slug: string, kind: AppEnvironmentKind): string {
  return kind === "preview" ? slug : `${slug}-live`;
}
/** instance names the helper accepts: an app slug, optionally with the -live suffix */
export const APP_INSTANCE_RE = /^[a-z][a-z0-9-]{0,33}[a-z0-9]$/;

/** a public hostname a client owns (lower case, at least two labels, no IP literal, no wildcard) */
const FQDN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const customDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(FQDN_RE, "Use a domain like app.example.com");
/** live environment of an app: the client's server and domain (+ up to 3 names that redirect to it, e.g. www.) */
export const liveEnvironmentInputSchema = z.object({
  serverId: z.uuid(),
  domain: customDomainSchema,
  extraDomains: z.array(customDomainSchema).max(3).default([]),
  memoryMb: z.number().int().min(256).max(2048).optional(),
});
// ---- live operations (Phase B3) ----
/** live sites are checked from the platform this often; history kept this long */
export const UPTIME_CHECK_EVERY_MS = 5 * 60_000;
export const UPTIME_RETENTION_DAYS = 30;
/** warn the Owners this many days before a live certificate expires (renewal is automatic) */
export const CERT_WARN_DAYS = 14;
export const UPTIME_STATUSES = ["unknown", "up", "down"] as const;
export type UptimeStatus = (typeof UPTIME_STATUSES)[number];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 h)");
/** when LIVE releases may start (rollbacks are always allowed); an end before the start spans midnight */
export const releaseWindowSchema = z.object({
  /** 0 = Sunday … 6 = Saturday, of the day the window STARTS */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  start: HHMM,
  end: HHMM,
  timeZone: z.string().min(1).max(64).default("Asia/Jakarta"),
});
export type ReleaseWindow = z.infer<typeof releaseWindowSchema>;

function minutesIn(timeZone: string, at: Date): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}
const hhmm = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));

/** whether `at` lies inside the window (start inclusive, end exclusive; overnight windows count from their start day) */
export function isWithinReleaseWindow(w: ReleaseWindow, at: Date = new Date()): boolean {
  const { day, minute } = minutesIn(w.timeZone, at);
  const start = hhmm(w.start);
  const end = hhmm(w.end);
  if (start === end) return w.days.includes(day);
  if (start < end) return w.days.includes(day) && minute >= start && minute < end;
  // overnight: today after the start, or the morning part of a window that started yesterday
  return (w.days.includes(day) && minute >= start) || (w.days.includes((day + 6) % 7) && minute < end);
}

export const liveEnvironmentUpdateSchema = z.object({
  domain: customDomainSchema.optional(),
  extraDomains: z.array(customDomainSchema).max(3).optional(),
  accessMode: z.enum(APP_ACCESS_MODES).optional(),
  /** null removes the window (releases any time) */
  releaseWindow: releaseWindowSchema.nullable().optional(),
});

/** whether a domain points at the environment's server (public DNS, A/AAAA) */
export const DOMAIN_CHECK_STATUSES = ["ok", "wrong", "missing", "error"] as const;
export type DomainCheckStatus = (typeof DOMAIN_CHECK_STATUSES)[number];
export interface DomainCheck {
  status: DomainCheckStatus;
  /** the addresses the domain(s) should resolve to (the server's) */
  expected: string[];
  /** per name: what public DNS answered */
  names: { name: string; status: DomainCheckStatus; found: string[] }[];
  checkedAt: string;
}

/**
 * Approval payload of request_release (Phase B3): a Developer proposes bringing a preview release that ran to LIVE.
 * Only an Owner (with step-up) can approve it; the executor re-checks that the preview release still qualifies.
 */
export const requestReleasePayloadSchema = z.object({
  appId: z.uuid(),
  appName: z.string(),
  environmentId: z.uuid(),
  url: z.string(),
  fromReleaseId: z.uuid(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  commitSubject: z.string().nullable(),
  /** the commit LIVE runs now (null: first LIVE release) */
  currentCommit: z.string().nullable(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })).max(50),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })).max(300),
  filesTruncated: z.boolean(),
  warnings: z.array(z.enum(RELEASE_WARNINGS)),
  migrations: z.enum(["expand", "breaking"]),
  database: z.boolean(),
  /** LIVE env names changed since the running LIVE release (names only) */
  liveEnvChanged: z.array(z.string()),
  /** the LIVE release window, if any (the release waits for it or is refused outside it) */
  releaseWindow: releaseWindowSchema.nullable(),
  summary: z.string().max(2000),
});
export type RequestReleasePayload = z.infer<typeof requestReleasePayloadSchema>;

/** a task waits for at most this many failed previews before it fails instead of being sent back again */
export const PREVIEW_MAX_FAILED_ATTEMPTS = 3;

/**
 * One environment of an app as the browser sees it: never the env values, the access password, APP_SECRET or the
 * database password — only the env names and whether a database exists.
 */
export interface AppEnvironmentDTO {
  id: string;
  kind: AppEnvironmentKind;
  serverId: string;
  serverName: string;
  /** preview: <slug>.<server baseDomain>; live: the client's domain */
  domain: string;
  /** live: names that redirect (301) to `domain` */
  extraDomains: string[];
  url: string;
  port: number;
  status: AppStatus;
  statusMessage: string | null;
  accessMode: AppAccessMode;
  envKeys: string[];
  hasDatabase: boolean;
  memoryMb: number;
  healthy: boolean | null;
  lastHealthAt: string | null;
  lastDeployedAt: string | null;
  currentRelease: ReleaseDTO | null;
  /** live: the last DNS check of domain + extraDomains (null: not checked since the names were set) */
  dnsCheck: DomainCheck | null;
  /** live blue-green (B2): the slot nginx sends traffic to (previews always "blue") */
  activeSlot: AppSlot;
  /** the maintenance page is shown instead of the app (a breaking migration, a restore) */
  maintenance: boolean;
  /** the last database backup of this environment (daily, manual, before a release or a restore), null: none yet */
  lastBackupAt: string | null;
  /** live (B3): up / down as the platform's uptime checks see it (previews always "unknown") */
  uptimeStatus: UptimeStatus;
  /** since when uptimeStatus holds (the last up↔down change), null: never changed */
  uptimeSince: string | null;
  /** the last uptime check */
  uptimeCheckedAt: string | null;
  /** live: when the served certificate expires (read during an uptime check), null: not read yet */
  certExpiresAt: string | null;
  /** live: when LIVE releases may start (null: any time; rollbacks always) */
  releaseWindow: ReleaseWindow | null;
}
export interface AppDTO {
  id: string;
  name: string;
  slug: string;
  repositoryId: string | null;
  repositoryName: string | null;
  branch: string;
  clientId: string | null;
  projectId: string | null;
  createdAt: string;
  preview: AppEnvironmentDTO;
  live: AppEnvironmentDTO | null;
}
export interface ReleaseDTO {
  id: string;
  appId: string;
  environmentId: string;
  environmentKind: AppEnvironmentKind;
  /** live: the preview release whose commit this one brings to live */
  promotedFromReleaseId: string | null;
  commit: string;
  branch: string;
  commitSubject: string | null;
  status: ReleaseStatus;
  trigger: ReleaseTrigger;
  step: ReleaseStep | null;
  warnings: ReleaseWarning[];
  error: string | null;
  approvalId: string | null;
  taskId: string | null;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
