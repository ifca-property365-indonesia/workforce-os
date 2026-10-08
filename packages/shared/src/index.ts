import { z } from "zod";

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
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const TASK_SOURCES = ["chat", "board", "routine", "team", "replay", "demo"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

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
  category: "knowledge" | "memory" | "clients" | "drafting" | "comms" | "billing" | "team" | "web" | "tasks" | "code";
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
  { name: "delegate_subtask", label: "Delegate subtask", description: "Team lead: assign a subtask to a team member", class: "reversible", credits: 0.05, category: "team" },
  { name: "request_revision", label: "Request revision", description: "Team lead: send a subtask back with feedback", class: "reversible", credits: 0.05, category: "team" },
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
 * Classify any tool name. Built-ins use the registry; unknown tools (e.g. from external
 * MCP servers) are classified by verb, and default to irreversible when unsure (fail closed).
 */
export function classifyTool(name: string, overrides?: Record<string, ToolClass>): ToolClass {
  const bare = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name;
  if (overrides?.[name]) return overrides[name];
  if (overrides?.[bare]) return overrides[bare];
  const builtin = TOOL_BY_NAME[bare];
  if (builtin) return builtin.class;
  const lower = bare.toLowerCase();
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((t) => REVERSIBLE_VERBS.includes(t)) && !tokens.some((t) => IRREVERSIBLE_VERBS.includes(t))) {
    return "reversible";
  }
  return "irreversible";
}

// ---------------------------------------------------------------------------
// Tool permissions & allow-list
// ---------------------------------------------------------------------------

export const toolPermissionSchema = z.object({
  tool: z.string().min(1),
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

export type GateDecision =
  | { kind: "run" }
  | { kind: "draft"; reason: string }
  | { kind: "approval"; reason: string }
  | { kind: "simulate"; reason: string }
  | { kind: "deny"; reason: string };

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
  const p = permissions.find((x) => x.tool === toolName);
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
  const perm = input.permissions.find((p) => p.tool === input.toolName);
  if (!perm || !perm.enabled) {
    return { kind: "deny", reason: `Tool "${input.toolName}" is not granted to this employee.` };
  }
  if (input.toolClass === "reversible") return { kind: "run" };

  // Irreversible from here on.
  if (input.dryRun) return { kind: "simulate", reason: "Dry run: irreversible action replaced by a mock." };
  const level = effectiveAutonomy(input.toolName, input.employeeAutonomy, input.permissions);
  if (level === "DRAFT") return { kind: "draft", reason: "Autonomy DRAFT: saved as a draft, nothing was sent." };
  if (level === "CLOSE") {
    const entry = input.allowList.find((e) => e.tool === input.toolName && allowListMatches(e, input.scope));
    if (entry) return { kind: "run" };
    return { kind: "approval", reason: "Irreversible action outside the Owner allow-list requires approval." };
  }
  return { kind: "approval", reason: `Irreversible action requires approval (autonomy ${level}).` };
}

/**
 * Run-level safety signals on top of the configured gate. Once a run is tainted by untrusted
 * content (or the payload looks like it leaks a secret), no irreversible action may run
 * unattended — not even one the Owner allow-listed.
 */
export function applyRunSignals(decision: GateDecision, s: { toolClass: ToolClass; tainted: boolean; highLeak?: boolean }): GateDecision {
  if (decision.kind !== "run" || s.toolClass !== "irreversible") return decision;
  if (s.highLeak) return { kind: "approval", reason: "Output guard found possible secrets/PII in the payload." };
  if (s.tainted) return { kind: "approval", reason: "Untrusted content with injection markers was read in this run." };
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
  | { type: "approval.created"; approvalId: string; taskId: string | null; title: string }
  | { type: "approval.updated"; approvalId: string; status: ApprovalStatus }
  | { type: "employee.updated"; employeeId: string; status: EmployeeStatus }
  | { type: "killswitch"; engaged: boolean }
  | { type: "replay.updated"; replayId: string; status: string }
  | { type: "demo.stage"; stage: string; detail: string };

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

export interface ChatMessageDTO {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  employeeId?: string | null;
  taskId?: string | null;
  attachments?: { name: string; size: number; documentId?: string }[];
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
  | { kind: "chat"; conversationId: string; messageId: string; workspaceId: string };

export type ActionJob =
  | { kind: "execute_approval"; approvalId: string; workspaceId: string }
  | { kind: "rejected_approval"; approvalId: string; workspaceId: string };
export type IngestJob = { kind: "ingest"; documentId: string; workspaceId: string };
export type MiscJob =
  | { kind: "replay"; replayId: string; workspaceId: string }
  | { kind: "demo"; workspaceId: string; userId: string }
  | { kind: "routine_run"; routineId: string; workspaceId: string; userId?: string }
  | { kind: "notify"; workspaceId: string; subject: string; text: string; link?: string };

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
  egressDomains: z.array(egressDomainSchema).max(50).default([]),
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

export const routineInputSchema = z.object({
  name: z.string().min(1).max(120),
  cron: z.string().min(9).max(120),
  timezone: z.string().default("Asia/Jakarta"),
  brief: z.string().min(1).max(20000),
  assigneeId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  perClient: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

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
});

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
