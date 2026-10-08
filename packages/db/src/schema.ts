
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
  vector,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";
import type {
  AllowListEntry,
  ToolPermission,
  ApprovalStatus,
  AutonomyLevel,
  EmployeeStatus,
  Role,
  StepKind,
  TaskSource,
  TaskStatus,
  Locale,
  OutputLanguage,
  ExecutionMode,
} from "@wfos/shared";

export const EMBEDDING_DIM = 384;

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  googleSub: text("google_sub").unique(),
  /** set for accounts created with a temporary password; cleared when the user picks their own */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /** sessions issued before this instant are rejected */
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  /** TOTP secret (AES-256-GCM); set once enrollment is confirmed */
  totpSecretEnc: text("totp_secret_enc"),
  /** secret shown during enrollment, promoted to totpSecretEnc after the first valid code */
  totpPendingEnc: text("totp_pending_enc"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  /** last accepted TOTP time step; codes at or below it are rejected (no replay) */
  totpLastCounter: integer("totp_last_counter"),
  /** SHA-256 hashes of unused recovery codes */
  recoveryCodes: jsonb("recovery_codes").$type<string[]>().notNull().default([]),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  /** linked Telegram chat (notifications, approve/reject buttons) */
  telegramChatId: text("telegram_chat_id").unique(),
  /** UI language preference (id | en); null = workspace default, then the browser */
  locale: text("locale").$type<Locale>(),
  createdAt: createdAt(),
});

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  monthlyBudget: doublePrecision("monthly_budget").notNull().default(5000),
  killSwitch: boolean("kill_switch").notNull().default(false),
  /** OWNER and ADMIN members must enroll in TOTP 2FA before using the workspace */
  require2faAdmins: boolean("require_2fa_admins").notNull().default(true),
  /** IANA time zone for dates in this workspace (project health, routines default) */
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  /** subscription limit reached: the queue is held until this instant (status PAUSED_QUOTA in the UI) */
  quotaPausedUntil: timestamp("quota_paused_until", { withTimezone: true }),
  quotaPauseReason: text("quota_pause_reason"),
  /** default UI and output language (id | en); null = follow each browser */
  defaultLocale: text("default_locale").$type<Locale>(),
  guardsEnabled: boolean("guards_enabled").notNull().default(true),
  demoMode: boolean("demo_mode").notNull().default(false),
  notifyEmail: text("notify_email"),
  webhookUrlEnc: text("webhook_url_enc"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const members = pgTable(
  "members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull().default("MEMBER"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/** Encrypted credentials (AES-256-GCM). Never returned to the client or the model. */
export const credentials = pgTable(
  "credentials",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // smtp | mcp | webhook | oauth
    name: text("name").notNull(),
    /** non-secret config (host, port, url...) */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secretEnc: text("secret_enc"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("credentials_ws_kind_name").on(t.workspaceId, t.kind, t.name)],
);

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

export const employees = pgTable(
  "employees",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    avatar: text("avatar").notNull().default("🤖"),
    role: text("role").notNull(),
    templateKey: text("template_key"),
    persona: text("persona").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    businessContext: text("business_context").notNull().default(""),
    model: text("model").notNull(),
    autonomyLevel: text("autonomy_level").$type<AutonomyLevel>().notNull().default("DRAFT"),
    toolPermissions: jsonb("tool_permissions").$type<ToolPermission[]>().notNull().default([]),
    allowList: jsonb("allow_list").$type<AllowListEntry[]>().notNull().default([]),
    dailyBudget: doublePrecision("daily_budget").notNull().default(200),
    status: text("status").$type<EmployeeStatus>().notNull().default("ACTIVE"),
    instructionsVersion: integer("instructions_version").notNull().default(1),
    /** language of answers and deliverables: inherit (workspace default) | id | en */
    outputLanguage: text("output_language").$type<OutputLanguage>().notNull().default("inherit"),
    /** tool = platform tools only (default); workspace = Claude Code in an isolated per-task sandbox */
    executionMode: text("execution_mode").$type<ExecutionMode>().notNull().default("tool"),
    /** extra hosts the sandbox may reach through the egress proxy (e.g. registry.npmjs.org) */
    egressDomains: jsonb("egress_domains").$type<string[]>().notNull().default([]),
    /** department key: SOP instructions and (Workspace mode) subagents */
    department: text("department"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("employees_ws").on(t.workspaceId)],
);

export const teams = pgTable("teams", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  leadId: uuid("lead_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.employeeId] })],
);

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

export const clients = pgTable("clients", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  contacts: jsonb("contacts").$type<{ name: string; email: string; role: string }[]>().notNull().default([]),
  notes: text("notes").notNull().default(""),
  currency: text("currency").notNull().default("IDR"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projects = pgTable("projects", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  description: text("description").notNull().default(""),
  hourlyRate: doublePrecision("hourly_rate").notNull().default(0),
  /** calendar date in the workspace time zone (YYYY-MM-DD) */
  deadline: date("deadline", { mode: "string" }),
  /** 0..100 */
  progress: integer("progress").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

export interface Deliverable {
  id: string;
  kind: "document" | "email_draft" | "invoice" | "code" | "summary" | "simulated_action" | "review" | "prd";
  title: string;
  content: string;
  /** unified diff vs previous version of the same title, if any */
  diff?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    assigneeId: uuid("assignee_id").references(() => employees.id, { onDelete: "set null" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id"),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    routineId: uuid("routine_id"),
    status: text("status").$type<TaskStatus>().notNull().default("QUEUED"),
    source: text("source").$type<TaskSource>().notNull().default("board"),
    dryRun: boolean("dry_run").notNull().default(false),
    /** team orchestration phase: plan | wait | review */
    phase: text("phase"),
    deliverables: jsonb("deliverables").$type<Deliverable[]>().notNull().default([]),
    result: text("result"),
    error: text("error"),
    costCredits: doublePrecision("cost_credits").notNull().default(0),
    /** Claude session of the last Workspace-mode run, resumed by follow-ups */
    agentSessionId: text("agent_session_id"),
    /** the task whose approved PRD created this one (Project → Developer handoff) */
    originTaskId: uuid("origin_task_id"),
    /** repository checked out into the task workspace (Workspace mode) */
    repositoryId: uuid("repository_id"),
    /** null | active | archived (workspace files removed after retention; deliverables kept) */
    workspaceStatus: text("workspace_status"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_ws_status").on(t.workspaceId, t.status),
    index("tasks_parent").on(t.parentTaskId),
    index("tasks_assignee").on(t.assigneeId),
  ],
);

export const routines = pgTable("routines", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  brief: text("brief").notNull(),
  assigneeId: uuid("assignee_id").references(() => employees.id, { onDelete: "set null" }),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
  perClient: boolean("per_client").notNull().default(false),
  dryRun: boolean("dry_run").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const routineRuns = pgTable("routine_runs", {
  id: id(),
  routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
  startedAt: createdAt(),
  trigger: text("trigger").notNull().default("schedule"), // schedule | manual
  taskIds: jsonb("task_ids").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("dispatched"),
  error: text("error"),
});

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    editedPayload: jsonb("edited_payload").$type<Record<string, unknown>>(),
    status: text("status").$type<ApprovalStatus>().notNull().default("PENDING"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    feedback: text("feedback"),
    executionResult: jsonb("execution_result").$type<Record<string, unknown>>(),
    guardFindings: jsonb("guard_findings").$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_ws_status").on(t.workspaceId, t.status)],
);

/** Activity / Step: every LLM call, tool call, guard hit, compaction, agent message. */
export const steps = pgTable(
  "steps",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id"),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    kind: text("kind").$type<StepKind>().notNull(),
    name: text("name").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    credits: doublePrecision("credits").notNull().default(0),
    input: jsonb("input"),
    output: jsonb("output"),
    status: text("status").notNull().default("ok"),
    createdAt: createdAt(),
  },
  (t) => [
    index("steps_task").on(t.taskId),
    index("steps_ws_created").on(t.workspaceId, t.createdAt),
    index("steps_employee_created").on(t.employeeId, t.createdAt),
  ],
);

/** Structured inter-agent channel. */
export const agentMessages = pgTable("agent_messages", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  fromEmployeeId: uuid("from_employee_id").references(() => employees.id, { onDelete: "set null" }),
  toEmployeeId: uuid("to_employee_id").references(() => employees.id, { onDelete: "set null" }),
  intent: text("intent").notNull(), // request | update | question | answer | review
  content: text("content").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export const conversations = pgTable("conversations", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New chat"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    content: text("content").notNull(),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    taskId: uuid("task_id"),
    attachments: jsonb("attachments").$type<{ name: string; size: number; documentId?: string }[]>().notNull().default([]),
    status: text("status").notNull().default("done"), // pending | streaming | done | error
    createdAt: createdAt(),
  },
  (t) => [index("messages_conv").on(t.conversationId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Memory & knowledge
// ---------------------------------------------------------------------------

export const memories = pgTable(
  "memories",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("fact"), // fact | feedback | preference
    content: text("content").notNull(),
    source: text("source").notNull().default("agent"), // agent | user | rejection
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    createdAt: createdAt(),
  },
  (t) => [index("memories_emp").on(t.employeeId)],
);

export const documents = pgTable("documents", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storage_path").notNull(),
  status: text("status").notNull().default("pending"), // pending | indexed | failed
  chunkCount: integer("chunk_count").notNull().default(0),
  error: text("error"),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  },
  (t) => [
    index("chunks_doc").on(t.documentId),
    index("chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ---------------------------------------------------------------------------
// Pricing, simulation, audit
// ---------------------------------------------------------------------------

export const modelPrices = pgTable("model_prices", {
  model: text("model").primaryKey(),
  label: text("label").notNull(),
  inputPer1k: doublePrecision("input_per_1k").notNull(),
  outputPer1k: doublePrecision("output_per_1k").notNull(),
  cacheReadPer1k: doublePrecision("cache_read_per_1k").notNull().default(0),
  cacheWritePer1k: doublePrecision("cache_write_per_1k").notNull().default(0),
  updatedAt: updatedAt(),
});

export const replays = pgTable("replays", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  proposed: jsonb("proposed").$type<{ instructions: string; persona: string; businessContext: string }>().notNull(),
  sampleSize: integer("sample_size").notNull().default(3),
  status: text("status").notNull().default("queued"), // queued | running | done | failed | promoted | discarded
  results: jsonb("results")
    .$type<{ taskId: string; title: string; oldOutput: string; newOutput: string; diff: string; credits: number }[]>()
    .notNull()
    .default([]),
  costCredits: doublePrecision("cost_credits").notNull().default(0),
  error: text("error"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** Immutable audit log: UPDATE/DELETE are blocked by a trigger (see migration 0001_audit_immutable). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_ws_created").on(t.workspaceId, t.createdAt)],
);

export const notifications = pgTable("notifications", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  link: text("link"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});


/** Git repositories connected to a workspace. The token stays with the platform; the agent never sees it. */
export const repositories = pgTable(
  "repositories",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").$type<"github" | "gitlab" | "git">().notNull(),
    /** https clone URL (no credentials in it) */
    url: text("url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    tokenEnc: text("token_enc"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repositories_ws_name").on(t.workspaceId, t.name)],
);

/** Latest Claude subscription limit per workspace credential and window (from the SDK's rate_limit_event). */
export const claudeLimits = pgTable(
  "claude_limits",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** workspace | instance: whose subscription this window belongs to */
    credentialSource: text("credential_source").$type<"workspace" | "instance">().notNull(),
    /** five_hour | seven_day | seven_day_opus | seven_day_sonnet | … */
    rateLimitType: text("rate_limit_type").notNull(),
    status: text("status").$type<"allowed" | "allowed_warning" | "rejected">().notNull(),
    /** 0..1 */
    utilization: doublePrecision("utilization"),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    /** highest warning (70/90) already sent for the current window, so it is sent once */
    warnedThreshold: integer("warned_threshold").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.credentialSource, t.rateLimitType] })],
);

/** Per-workspace, editable copy of a department: bilingual SOP and subagent definitions. */
export const departments = pgTable(
  "departments",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: jsonb("name").$type<{ en: string; id: string }>().notNull(),
    sop: jsonb("sop").$type<{ en: string; id: string }>().notNull(),
    subagents: jsonb("subagents")
      .$type<{ name: string; description: { en: string; id: string }; prompt: { en: string; id: string }; tools?: string[] }[]>()
      .notNull()
      .default([]),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/** One-time codes for linking a Telegram chat to a user (stored hashed, 10 minutes). */
export const telegramLinkCodes = pgTable("telegram_link_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Approve/reject buttons sent to Telegram: single-use, bound to one user and one approval. */
export const telegramCallbacks = pgTable("telegram_callbacks", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
  action: text("action").$type<"approve" | "reject">().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});
