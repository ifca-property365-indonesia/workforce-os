
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
  vector,
  primaryKey,
  date,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  SkillSource,
  MemoryEventAction,
  NotificationChannelPrefs,
  RoutineOverlap,
  IncidentKind,
  WebhookDeliveryStatus,
  IncidentStatus,
  MessageMeta,
  TeamResponderMode,
  TeamMemberRole,
  ProjectHealth,
  Bilingual,
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
  OfficeLook,
  StoredChatAttachment,
  StoredClientContact,
  ClientStatus,
  InvoiceLine,
  InvoiceStatus,
  BillingPeriod,
  OutboundEmailKind,
  OutboundEmailStatus,
  OutboundEmailTrigger,
  ServerRole,
  ServerStatus,
  ServerInfo,
  AppStatus,
  AppAccessMode,
  AppManifest,
  ReleaseStatus,
  ReleaseTrigger,
  ReleaseStep,
  ReleaseWarning,
  ReleaseCheckpoint,
  AppEnvironmentKind,
  DomainCheck,
  AppSlot,
  AppBackupKind,
  UptimeStatus,
  ReleaseWindow,
  TaskWorkMode,
  TaskReviewPolicy,
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
    dailyBudget: doublePrecision("daily_budget").notNull().default(1000),
    status: text("status").$type<EmployeeStatus>().notNull().default("ACTIVE"),
    instructionsVersion: integer("instructions_version").notNull().default(1),
    /** language of answers and deliverables: inherit (workspace default) | id | en */
    outputLanguage: text("output_language").$type<OutputLanguage>().notNull().default("inherit"),
    /** tool = platform tools only (default); workspace = Claude Code in an isolated per-task sandbox */
    executionMode: text("execution_mode").$type<ExecutionMode>().notNull().default("tool"),
    /** extra hosts the sandbox may reach through the egress proxy (e.g. registry.npmjs.org) */
    egressDomains: jsonb("egress_domains").$type<string[]>().notNull().default([]),
    /** one line of expertise: how a division head or code lead picks this employee */
    specialty: text("specialty").notNull().default(""),
    /** office character (officeLookSchema); null derives one from the id */
    look: jsonb("look").$type<OfficeLook>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("employees_ws").on(t.workspaceId)],
);

/**
 * A view-only link (after AIRIS 1f1b126): someone without an account opens the workspace read-only until it expires
 * or is revoked. Only the token's hash is kept; what a guest may read is an allow-list (lib/server/share.ts).
 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    opens: integer("opens").notNull().default(0),
  },
  (t) => [uniqueIndex("share_links_token").on(t.tokenHash), index("share_links_ws").on(t.workspaceId, t.createdAt)],
);

/** what changed an employee's configuration (P2): a person, an HR replay, a skill install, a restore… */
export const EMPLOYEE_REVISION_SOURCES = ["baseline", "person", "replay", "hr_auto", "skills", "skill_install", "rollback"] as const;
export type EmployeeRevisionSource = (typeof EMPLOYEE_REVISION_SOURCES)[number];
/** the part of an employee a revision keeps (what shapes its work), with its assigned skills */
export interface EmployeeConfig {
  role: string;
  persona: string;
  instructions: string;
  businessContext: string;
  model: string;
  autonomyLevel: AutonomyLevel;
  toolPermissions: ToolPermission[];
  allowList: AllowListEntry[];
  dailyBudget: number;
  outputLanguage: OutputLanguage;
  executionMode: ExecutionMode;
  egressDomains: string[];
  specialty: string;
  skillIds: string[];
}

/**
 * P2 (after Paperclip): every change to an employee's configuration is a numbered revision with a full snapshot, so a
 * change by a person, an HR replay or a skill install can be compared and rolled back. Version 1 is the state before
 * the first recorded change ("baseline").
 */
export const employeeRevisions = pgTable(
  "employee_revisions",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").$type<EmployeeConfig>().notNull(),
    source: text("source").$type<EmployeeRevisionSource>().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull().default(""),
    note: text("note").notNull().default(""),
    /** a rollback: the version it restored */
    restoredVersion: integer("restored_version"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("employee_revisions_version").on(t.employeeId, t.version)],
);

/**
 * A division (UI: "Divisi"): the unit work is assigned to. The head (leadId) takes division tasks and either does them
 * or delegates to members; the code lead (codeLeadId) works in a Workspace-mode sandbox and loads the members with
 * role "subagent" as Claude Code subagents (one branch per task). Every employee belongs to at most one division.
 */
export const teams = pgTable(
  "teams",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** stable slug (e.g. delivery, support); null for divisions made before 0031 */
    key: text("key"),
    description: text("description").notNull().default(""),
    /** head of the division: takes division-level tasks */
    leadId: uuid("lead_id").references(() => employees.id, { onDelete: "set null" }),
    /** member who runs code work in a sandbox; the division's "subagent" members work inside that run */
    codeLeadId: uuid("code_lead_id").references(() => employees.id, { onDelete: "set null" }),
    /** who answers an un-mentioned message in the team chat */
    responderMode: text("responder_mode").$type<TeamResponderMode>().notNull().default("lead"),
    /** standard operating procedure, both languages (the employee's output language picks one) */
    sop: jsonb("sop").$type<Bilingual>().notNull().default({ en: "", id: "" }),
    /** hex colour for the org chart and the office (#rrggbb), "" = derived */
    color: text("color").notNull().default(""),
    /** division-level runs (head, members, code lead) at the same time; enforced with a Redis lease */
    maxParallel: integer("max_parallel").notNull().default(1),
    /** credits per day across the division's members; null = only the employees' own budgets apply */
    dailyBudget: doublePrecision("daily_budget"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("teams_ws_key").on(t.workspaceId, t.key).where(sql`key is not null`)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    /** member: takes subtasks from the head · subagent: works inside the code lead's sandbox run */
    role: text("role").$type<TeamMemberRole>().notNull().default("member"),
  },
  // one division per employee
  (t) => [primaryKey({ columns: [t.teamId, t.employeeId] }), uniqueIndex("team_members_employee").on(t.employeeId)],
);

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

export const clients = pgTable("clients", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** short client code (e.g. GOB), unique per workspace when set; "" = none */
  code: text("code").notNull().default(""),
  website: text("website").notNull().default(""),
  industry: text("industry").notNull().default(""),
  email: text("email").notNull().default(""),
  /** read through clientContactSchema: rows written before 0025 lack phone/receives (defaults apply) */
  contacts: jsonb("contacts").$type<StoredClientContact[]>().notNull().default([]),
  notes: text("notes").notNull().default(""),
  currency: text("currency").notNull().default("IDR"),
  /** active | prospect | inactive */
  status: text("status").$type<ClientStatus>().notNull().default("active"),
  legalName: text("legal_name").notNull().default(""),
  /** tax id (NPWP) printed on invoices */
  taxId: text("tax_id").notNull().default(""),
  address: text("address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  /** C5: the UI template of this client's apps (built-in kit id or custom:<id>), unless an app sets its own */
  uiTemplate: text("ui_template"),
  /** C5: the client's Figma file: the apps follow it (read-only for employees) */
  figmaUrl: text("figma_url"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("clients_ws_code").on(t.workspaceId, t.code).where(sql`code <> ''`)]);

/**
 * P1 (after Paperclip): a goal of the workspace, optionally under a broader one and owned by a division. Tasks and
 * projects point at one (subtasks and follow-ups inherit it), so the Owner sees what the credits were spent for.
 */
export const GOAL_STATUSES = ["active", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const goals = pgTable(
  "goals",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => goals.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** the division that owns it (null: the whole workspace) */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    status: text("status").$type<GoalStatus>().notNull().default("active"),
    /** calendar date in the workspace time zone (YYYY-MM-DD) */
    targetDate: date("target_date", { mode: "string" }),
    position: integer("position").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("goals_ws").on(t.workspaceId, t.status)],
);

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
  /** division responsible: tasks for this project without an assignee go to it */
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
  /** P1: the goal this project serves (its tasks inherit it) */
  goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
  /** calendar date in the workspace time zone (YYYY-MM-DD) */
  startDate: date("start_date", { mode: "string" }),
  nextMilestone: text("next_milestone").notNull().default(""),
  /** on_track | at_risk | late */
  health: text("health").$type<ProjectHealth>().notNull().default("on_track"),
  nextStep: text("next_step").notNull().default(""),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
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
    /** P1: the goal this task serves (given, or inherited from its parent, origin or project) */
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    /** P4: standard | ask (answer only) | plan (a plan only); subtasks inherit it */
    workMode: text("work_mode").$type<TaskWorkMode>().notNull().default("standard"),
    /** P4: auto | person (a person accepts the result: reviewedAt) */
    reviewPolicy: text("review_policy").$type<TaskReviewPolicy>().notNull().default("auto"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
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
    /** the task this one came from: an approved PRD, a handoff to another division, a reassigned subtask */
    originTaskId: uuid("origin_task_id"),
    /** sibling subtasks that must be DONE before this one starts (their deliverables are passed in as data) */
    dependsOn: uuid("depends_on").array().notNull().default(sql`'{}'::uuid[]`),
    /** repository checked out into the task workspace (Workspace mode) */
    repositoryId: uuid("repository_id"),
    /** null | active | archived (workspace files removed after retention; deliverables kept) */
    workspaceStatus: text("workspace_status"),
    /** Workspace-mode run time of this task, all runs together (only grows) */
    sandboxSeconds: integer("sandbox_seconds").notNull().default(0),
    /** sandboxSeconds when a person last let the task go on (retry, request changes): the time limit counts from here */
    sandboxSecondsBase: integer("sandbox_seconds_base").notNull().default(0),
    /** automatic retries by the team lead after an incident (bounded by INCIDENT_RETRY_LIMIT) */
    retryCount: integer("retry_count").notNull().default(0),
    /** created from untrusted input (webhook payload): the run starts tainted */
    untrustedInput: boolean("untrusted_input").notNull().default(false),
    /** 0..100 reported by the assignee (report_progress); null = never reported */
    progress: integer("progress"),
    progressNote: text("progress_note"),
    progressAt: timestamp("progress_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_ws_status").on(t.workspaceId, t.status),
    index("tasks_parent").on(t.parentTaskId),
    // Ctrl+K search (migration 0033): the search API must use exactly this expression (taskSearchVector)
    index("tasks_search").using("gin", sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.brief}, ''))`),
    index("tasks_assignee").on(t.assigneeId),
  ],
);

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IncidentKind>().notNull(),
    status: text("status").$type<IncidentStatus>().notNull().default("open"),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id").references(() => tasks.id, { onDelete: "set null" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    /** the team lead that got the incident turn (null = escalated to a person) */
    handlerEmployeeId: uuid("handler_employee_id").references(() => employees.id, { onDelete: "set null" }),
    summary: text("summary").notNull().default(""),
    resolution: text("resolution"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("incidents_ws_status").on(t.workspaceId, t.status, t.createdAt), index("incidents_task").on(t.taskId)],
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
  /** when the previous firing is still running: skip this one, or queue another run anyway */
  overlap: text("overlap").$type<RoutineOverlap>().notNull().default("skip"),
  /** proposed by a tainted run: tasks it creates start tainted */
  untrustedInput: boolean("untrusted_input").notNull().default(false),
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
    /** set when a chat run raised it: the conversation and the assistant message that shows it inline */
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
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
    /** who acted when it was not the run's employee: a division member working as a subagent in the code lead's run */
    actorEmployeeId: uuid("actor_employee_id").references(() => employees.id, { onDelete: "set null" }),
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
    index("steps_actor_created").on(t.actorEmployeeId, t.createdAt).where(sql`actor_employee_id is not null`),
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
  /** written by a tainted run: shown to the recipient as data and taints the recipient's run */
  untrusted: boolean("untrusted").notNull().default(false),
  /** the client of the sender's run; a run for another client never sees the message */
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
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
  /** the message the thread currently ends at; edits and regenerations fork branches below it */
  activeLeafId: uuid("active_leaf_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    /** previous message on this branch (null for the first message) */
    parentId: uuid("parent_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    content: text("content").notNull(),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    taskId: uuid("task_id"),
    attachments: jsonb("attachments").$type<StoredChatAttachment[]>().notNull().default([]),
    status: text("status").notNull().default("done"), // pending | streaming | done | error
    /** user messages: set when a chat run folds the message into a turn (null = still waiting for a reply) */
    handledAt: timestamp("handled_at", { withTimezone: true }),
    meta: jsonb("meta").$type<MessageMeta>().notNull().default({}),
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
    /** learned on a task for this client: recalled only on that client's work (null = general) */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("fact"), // fact | feedback | preference
    content: text("content").notNull(),
    source: text("source").notNull().default("agent"), // agent | user | rejection | import
    /** saved by a tainted run (or imported): recalled as data, and recalling it taints the run */
    untrusted: boolean("untrusted").notNull().default(false),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    /** not recalled after this time (tidy also expires it) */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** a newer memory replaced this one; superseded memories are not recalled */
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => memories.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memories_emp").on(t.employeeId, t.clientId)],
);

export const documents = pgTable("documents", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storage_path").notNull(),
  /** knowledge for one client: searchable only on that client's work (null = general knowledge) */
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
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
  /** C2: the HR review that proposed these instructions (then a judge decides whether they apply on their own) */
  hrReviewId: uuid("hr_review_id").references((): AnyPgColumn => hrReviews.id, { onDelete: "set null" }),
  judge: jsonb("judge").$type<ReplayJudge>(),
  autoApplied: boolean("auto_applied").notNull().default(false),
});

/** C2: the judge of a replay proposed by an HR review: per replayed task, is the new output better, the same or worse */
export interface ReplayJudge {
  passed: boolean;
  model: string;
  verdicts: { taskId: string; verdict: "better" | "same" | "worse"; reason: string }[];
  /** set when the judge could not decide (no credential, invalid answers): then a person decides */
  error?: string;
}

/** C2: the platform's exact metrics of one employee over a period (packages/db/src/hr-metrics.ts) */
export interface EmployeeMetrics {
  days: number;
  tasks: { done: number; failed: number; cancelled: number; total: number };
  successRate: number | null;
  incidents: { total: number; byKind: Record<string, number> };
  approvals: { requested: number; executed: number; rejected: number; edited: number; expired: number };
  changesRequested: number;
  credits: number;
  activeMinutes: number;
  costliestTasks: { id: string; title: string; credits: number }[];
}

/** C2: an HR review of one employee: exact metrics, the HR employee's assessment, maybe an instruction proposal. */
export const hrReviews = pgTable(
  "hr_reviews",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    reviewerTaskId: uuid("reviewer_task_id").references(() => tasks.id, { onDelete: "set null" }),
    periodDays: integer("period_days").notNull().default(30),
    metrics: jsonb("metrics").$type<EmployeeMetrics>().notNull(),
    metricScore: integer("metric_score"),
    score: integer("score"),
    summary: text("summary"),
    strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
    issues: jsonb("issues").$type<string[]>().notNull().default([]),
    recommendations: jsonb("recommendations").$type<{ type: "model" | "tools" | "skill" | "workload" | "other"; text: string }[]>().notNull().default([]),
    status: text("status").$type<"running" | "done" | "error">().notNull().default("running"),
    replayId: uuid("replay_id").references((): AnyPgColumn => replays.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("hr_reviews_employee").on(t.employeeId, t.createdAt), uniqueIndex("hr_reviews_task").on(t.reviewerTaskId)],
);

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
  /** null = for every member of the workspace */
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** the employee it is about (per-user mutes) */
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
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

/** Web Push subscriptions (one per browser/device). Endpoints are limited to known push services. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint").on(t.endpoint), index("push_subscriptions_user").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Inbound webhooks & API tokens
// ---------------------------------------------------------------------------

export const webhookTriggers = pgTable(
  "webhook_triggers",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** sha256 hex of the bearer secret (shown once at creation) */
    secretHash: text("secret_hash").notNull(),
    assigneeId: uuid("assignee_id").references(() => employees.id, { onDelete: "set null" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    /** task brief; the payload is appended as a fenced data block */
    briefTemplate: text("brief_template").notNull().default(""),
    dryRun: boolean("dry_run").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_triggers_ws").on(t.workspaceId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    triggerId: uuid("trigger_id").notNull().references(() => webhookTriggers.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key"),
    /** accepted | duplicate | rejected | failed */
    status: text("status").$type<WebhookDeliveryStatus>().notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    error: text("error"),
    /** first characters of the payload, secrets redacted */
    payloadExcerpt: text("payload_excerpt").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_trigger").on(t.triggerId, t.receivedAt),
    index("webhook_deliveries_received").on(t.receivedAt),
    uniqueIndex("webhook_deliveries_idem").on(t.triggerId, t.idempotencyKey).where(sql`idempotency_key is not null`),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** sha256 hex of the token; the token itself is shown once */
    tokenHash: text("token_hash").notNull(),
    /** first characters of the token (e.g. "wfos_ab12") so the owner can recognise it */
    prefix: text("prefix").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["mcp"]),
    /** tasks and chat messages this token creates start tainted (machine clients are untrusted by default) */
    markUntrusted: boolean("mark_untrusted").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("api_tokens_ws_user").on(t.workspaceId, t.userId), uniqueIndex("api_tokens_hash").on(t.tokenHash)],
);

// ---------------------------------------------------------------------------
// Memory journal & per-user notifications
// ---------------------------------------------------------------------------

/** Every change to an employee's memory, with before/after, so a person can undo it. */
export const memoryEvents = pgTable(
  "memory_events",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    /** no FK: the journal outlives deleted memories so a delete can be undone */
    memoryId: uuid("memory_id"),
    action: text("action").$type<MemoryEventAction>().notNull(),
    /** agent | user | tidy | import | rejection */
    actor: text("actor").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("memory_events_emp").on(t.employeeId, t.createdAt)],
);

export const notificationReads = pgTable(
  "notification_reads",
  {
    notificationId: uuid("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userId] })],
);

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** per notification kind, which channels are on (missing = default on) */
    channels: jsonb("channels").$type<NotificationChannelPrefs>().notNull().default({}),
    mutedEmployeeIds: jsonb("muted_employee_ids").$type<string[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

// ---------------------------------------------------------------------------
// Skills (SKILL.md)
// ---------------------------------------------------------------------------

export const skills = pgTable(
  "skills",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** kebab-case name, unique per workspace */
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    /** the SKILL.md body (markdown, no frontmatter) */
    body: text("body").notNull(),
    source: text("source").$type<SkillSource>().notNull().default("user"),
    enabled: boolean("enabled").notNull().default(true),
    /** proposed by a tainted run or imported: read back as data and taints the reader's run */
    untrusted: boolean("untrusted").notNull().default(false),
    /** sha256 of slug + description + body as saved, to spot edits of imported/learned skills */
    provenanceHash: text("provenance_hash").notNull(),
    /** C4: where a catalog skill came from, pinned (GitHub source, path, commit, license, SKILL.md hash) */
    origin: jsonb("origin").$type<SkillOrigin>(),
    /** C4: text files next to SKILL.md (scripts, references), installed with it in a sandbox */
    files: jsonb("files").$type<{ path: string; content: string }[]>().notNull().default([]),
    /** C4: a newer commit of the catalog skill's folder, found by the weekly check (never applied by itself) */
    updateAvailable: jsonb("update_available").$type<{ commit: string; checkedAt: string } | null>(),
    originCheckedAt: timestamp("origin_checked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("skills_ws_slug").on(t.workspaceId, t.slug)],
);

export const employeeSkills = pgTable(
  "employee_skills",
  {
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.skillId] }), index("employee_skills_skill").on(t.skillId)],
);

// ---------------------------------------------------------------------------
// Outbox & billing (0025)
// ---------------------------------------------------------------------------

/**
 * Every email the platform tried to send on an employee's behalf (send_email / send_invoice), one row per attempt.
 * Pending, rejected and expired proposals are not here: they live in `approvals` and the outbox API merges them in.
 */
export const outboundEmails = pgTable(
  "outbound_emails",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<OutboundEmailKind>().notNull(),
    /** sending → sent | failed */
    status: text("status").$type<OutboundEmailStatus>().notNull().default("sending"),
    trigger: text("trigger").$type<OutboundEmailTrigger>().notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    to: jsonb("to").$type<string[]>().notNull().default([]),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    attachments: jsonb("attachments").$type<{ filename: string; size: number; contentType?: string }[]>().notNull().default([]),
    /** the exact payload that was executed (send_email / send_invoice shape): a resend uses it as-is */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    error: text("error"),
    messageId: text("message_id"),
    /** the failed attempt this one retries */
    resendOf: uuid("resend_of").references((): AnyPgColumn => outboundEmails.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("outbound_emails_ws_created").on(t.workspaceId, t.createdAt), index("outbound_emails_client").on(t.clientId)],
);

/** Recurring billing per client: on its day the scheduler drafts an invoice and asks a person to approve sending it. */
export const recurringBillings = pgTable(
  "recurring_billings",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    /** per period, in the client's currency, before tax */
    amount: doublePrecision("amount").notNull(),
    taxPercent: doublePrecision("tax_percent").notNull().default(0),
    dueDays: integer("due_days").notNull().default(14),
    period: text("period").$type<BillingPeriod>().notNull().default("monthly"),
    /** 1..28 */
    dayOfMonth: integer("day_of_month").notNull().default(1),
    /** 1..12, yearly only */
    startMonth: integer("start_month"),
    active: boolean("active").notNull().default(true),
    /** shown as the requester on the approval (usually a Finance employee); null = the system */
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    /** empty = the client's contacts that receive invoices, else the client's main email */
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    /** last period invoiced: YYYY-MM (monthly) or YYYY (yearly) */
    lastPeriod: text("last_period"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("recurring_billings_due").on(t.active, t.nextRunAt), index("recurring_billings_client").on(t.clientId)],
);

/** Invoice ledger: drafted (draft_invoice / recurring), sent (send_invoice executed), then marked paid or void by a person. */
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    number: text("number").notNull(),
    currency: text("currency").notNull().default("IDR"),
    lines: jsonb("lines").$type<InvoiceLine[]>().notNull().default([]),
    subtotal: doublePrecision("subtotal").notNull().default(0),
    taxPercent: doublePrecision("tax_percent").notNull().default(0),
    tax: doublePrecision("tax").notNull().default(0),
    total: doublePrecision("total").notNull().default(0),
    /** YYYY-MM-DD */
    dueDate: date("due_date", { mode: "string" }),
    notes: text("notes").notNull().default(""),
    status: text("status").$type<InvoiceStatus>().notNull().default("draft"),
    /** YYYY-MM / YYYY for recurring invoices */
    period: text("period"),
    recurringId: uuid("recurring_id").references(() => recurringBillings.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    emailId: uuid("email_id").references(() => outboundEmails.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoices_ws_number").on(t.workspaceId, t.number),
    index("invoices_client").on(t.clientId, t.createdAt),
    // one invoice per recurring billing per period, even if two schedulers race
    uniqueIndex("invoices_recurring_period").on(t.recurringId, t.period),
  ],
);

// ---------------------------------------------------------------------------
// App servers (0026): servers a workspace registers to run the apps its employees build
// ---------------------------------------------------------------------------

/**
 * A server the workspace owns, reached over SSH as an unprivileged user (default `wfos-apps`) with the workspace's own
 * key (credentials kind "ssh"). Root work goes only through the validated helper installed by prepare.sh.
 * The host key is pinned when an Owner confirms its fingerprint; a different key is refused from then on.
 */
export const servers = pgTable(
  "servers",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull().default("wfos-apps"),
    /** dev = previews (Phase A); live = production releases (Phase B) */
    role: text("role").$type<ServerRole>().notNull().default("dev"),
    /** apps are served at <slug>.<baseDomain>; DNS *.<baseDomain> must point at this server */
    baseDomain: text("base_domain").notNull(),
    /** pinned host key: algorithm + base64 key blob, set on verification */
    hostKeyAlgo: text("host_key_algo"),
    hostKey: text("host_key"),
    hostKeyFingerprint: text("host_key_fingerprint"),
    status: text("status").$type<ServerStatus>().notNull().default("pending"),
    statusMessage: text("status_message"),
    /** at most this many apps run at once on this server */
    maxRunningApps: integer("max_running_apps").notNull().default(3),
    /** last probe: helper/node/pnpm versions, disk and memory */
    info: jsonb("info").$type<ServerInfo>(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("servers_ws_name").on(t.workspaceId, t.name), uniqueIndex("servers_ws_domain").on(t.workspaceId, t.baseDomain)],
);

/** An app an employee builds, previewed on one of the workspace's servers at https://<slug>.<server baseDomain>. */
export const apps = pgTable(
  "apps",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** @deprecated since 0028: the preview environment's server (app_environments); kept for a rollback, not maintained */
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "restrict" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** subdomain and name on the server; fixed once created */
    slug: text("slug").notNull(),
    /** @deprecated since 0028 (app_environments.domain) */
    domain: text("domain"),
    /** branch a manual deploy takes by default */
    branch: text("branch").notNull().default("main"),
    /** @deprecated since 0028 (app_environments.port) */
    port: integer("port"),
    status: text("status").$type<AppStatus>().notNull().default("new"),
    statusMessage: text("status_message"),
    currentReleaseId: uuid("current_release_id").references((): AnyPgColumn => appReleases.id, { onDelete: "set null" }),
    accessMode: text("access_mode").$type<AppAccessMode>().notNull().default("password"),
    /** preview password (basic auth, user "preview"), encrypted; the server only gets its bcrypt hash */
    accessPasswordEnc: text("access_password_enc"),
    /** extra env (JSON object), encrypted, never sent back to a browser or an agent */
    envEnc: text("env_enc"),
    /** APP_SECRET, generated once, encrypted */
    appSecretEnc: text("app_secret_enc"),
    /** password of the app's database role, set when the manifest first asks for a database */
    dbPasswordEnc: text("db_password_enc"),
    memoryMb: integer("memory_mb").notNull().default(512),
    /** C5: this app's UI template (null: its client's) and Figma file (null: its client's) */
    uiTemplate: text("ui_template"),
    figmaUrl: text("figma_url"),
    healthy: boolean("healthy"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    lastDeployedAt: timestamp("last_deployed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("apps_ws_name").on(t.workspaceId, t.name),
    uniqueIndex("apps_ws_slug").on(t.workspaceId, t.slug),
  ],
);

/** One deploy (or rollback) of an app: the exact commit, what happened, and its (redacted, capped) log. */
export const appReleases = pgTable(
  "app_releases",
  {
    id: id(),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    commit: text("commit").notNull(),
    branch: text("branch").notNull(),
    commitSubject: text("commit_subject"),
    status: text("status").$type<ReleaseStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<ReleaseTrigger>().notNull(),
    /** the step running now, or the one that failed */
    step: text("step").$type<ReleaseStep>(),
    warnings: jsonb("warnings").$type<ReleaseWarning[]>().notNull().default([]),
    /** the validated wfos-app.json of this commit */
    manifest: jsonb("manifest").$type<AppManifest>(),
    /** C8: the modules whose merged work this release's commit contains (null: not worked out) */
    modules: jsonb("modules").$type<string[]>(),
    /** secrets redacted, capped (the tail is kept) */
    log: text("log").notNull().default(""),
    error: text("error"),
    /** name of the database backup taken before this release's migration (on the server) */
    dbBackup: text("db_backup"),
    /** how far the pipeline got (so a release cut off by a restart can be undone like a failure) */
    checkpoint: jsonb("checkpoint").$type<ReleaseCheckpoint>(),
    /** the environment (preview / live) this release runs in */
    environmentId: uuid("environment_id")
      .notNull()
      .references((): AnyPgColumn => appEnvironments.id, { onDelete: "cascade" }),
    /** live: the preview release whose commit this release brings to live */
    promotedFromReleaseId: uuid("promoted_from_release_id").references((): AnyPgColumn => appReleases.id, { onDelete: "set null" }),
    /** rollback: the release whose commit is brought back */
    rollbackOfId: uuid("rollback_of_id").references((): AnyPgColumn => appReleases.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("app_releases_app").on(t.appId, t.createdAt),
    index("app_releases_ws_status").on(t.workspaceId, t.status),
    index("app_releases_env").on(t.environmentId, t.createdAt),
  ],
);

/**
 * Where an app runs (Phase B): its preview on the workspace's dev server, and (optionally) its live environment on a
 * client's server at the client's own domain. Each has its own server instance, port, domain, env, database and
 * releases. Created for every app's preview by migration 0028 from the fields that used to live on `apps`.
 */
export const appEnvironments = pgTable(
  "app_environments",
  {
    id: id(),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AppEnvironmentKind>().notNull(),
    /** a server with environments cannot be deleted (remove them first) */
    serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "restrict" }),
    /** the helper's name for it on the server (user wa-<name>, /srv/wfos-apps/<name>, unit wfos-app-<name>, db app_<name>) */
    instanceName: text("instance_name").notNull(),
    /** preview: <slug>.<server baseDomain>; live: the client's domain. Globally unique */
    domain: text("domain").notNull(),
    /** live: more names that redirect to `domain` (e.g. www.<domain>) */
    extraDomains: jsonb("extra_domains").$type<string[]>().notNull().default([]),
    /** live: whether the domain(s) point at the server (checked before a certificate is asked for) */
    dnsCheck: jsonb("dns_check").$type<DomainCheck>(),
    port: integer("port").notNull(),
    status: text("status").$type<AppStatus>().notNull().default("new"),
    statusMessage: text("status_message"),
    currentReleaseId: uuid("current_release_id").references((): AnyPgColumn => appReleases.id, { onDelete: "set null" }),
    /** preview: password (default); live: public (default) */
    accessMode: text("access_mode").$type<AppAccessMode>().notNull().default("password"),
    accessPasswordEnc: text("access_password_enc"),
    /** extra env of THIS environment (live and preview never share values), encrypted */
    envEnc: text("env_enc"),
    appSecretEnc: text("app_secret_enc"),
    dbPasswordEnc: text("db_password_enc"),
    /** C10: shared password of the test accounts (preview only; WFOS_TEST_PASSWORD in the env file), encrypted */
    testPasswordEnc: text("test_password_enc"),
    /** when the testUsers script last ran, and what it said (or why it failed) */
    testUsersAt: timestamp("test_users_at", { withTimezone: true }),
    testUsersNote: text("test_users_note"),
    memoryMb: integer("memory_mb").notNull().default(512),
    healthy: boolean("healthy"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    lastDeployedAt: timestamp("last_deployed_at", { withTimezone: true }),
    /** live blue-green (B2): the slot nginx sends traffic to (blue = port, green = port + APP_ALT_PORT_OFFSET) */
    activeSlot: text("active_slot").$type<AppSlot>().notNull().default("blue"),
    /** live: the maintenance page is shown instead of the app (a breaking migration, a restore) */
    maintenance: boolean("maintenance").notNull().default(false),
    /** live: last daily database backup */
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    /** live uptime (B3): checked from the platform every UPTIME_CHECK_EVERY_MS */
    uptimeStatus: text("uptime_status").$type<UptimeStatus>().notNull().default("unknown"),
    /** since when uptimeStatus holds (the last up↔down change) */
    uptimeSince: timestamp("uptime_since", { withTimezone: true }),
    uptimeCheckedAt: timestamp("uptime_checked_at", { withTimezone: true }),
    /** live: when the served certificate expires (read during the uptime check) */
    certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),
    /** live: when releases may start (null = any time; rollbacks always) */
    releaseWindow: jsonb("release_window").$type<ReleaseWindow>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("app_env_app_kind").on(t.appId, t.kind),
    uniqueIndex("app_env_server_instance").on(t.serverId, t.instanceName),
    uniqueIndex("app_env_server_port").on(t.serverId, t.port),
    uniqueIndex("app_env_domain").on(t.domain),
    index("app_env_ws").on(t.workspaceId),
  ],
);

/**
 * C10: a test account per role on an environment (preview), for the browser tester and for people trying the app.
 * auto rows come from the app's testUsers script and are replaced on every preview release; manual rows are kept.
 */
export const appTestUsers = pgTable(
  "app_test_users",
  {
    id: id(),
    environmentId: uuid("environment_id").notNull().references(() => appEnvironments.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    label: text("label").notNull(),
    username: text("username").notNull(),
    /** null: the environment's shared test password */
    passwordEnc: text("password_enc"),
    totpEnc: text("totp_enc"),
    loginPath: text("login_path").notNull().default("/"),
    source: text("source").$type<"auto" | "manual">().notNull().default("auto"),
    viewAll: boolean("view_all").notNull().default(false),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("app_test_users_env_role").on(t.environmentId, t.role), index("app_test_users_ws").on(t.workspaceId)],
);

/** C3: a finding of a browser test (what the tester saw, so a fix task can be made from it) */
export interface AppTestFinding {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  role: string | null;
  path: string | null;
  steps: string;
  expected: string;
  actual: string;
}

/** C3: a browser test of an app's preview, run as a task of a tester employee. */
export const appTests = pgTable(
  "app_tests",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => appEnvironments.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** the preview's commit when the test started */
    commit: text("commit"),
    /** queued / cancelled: a package of a full test (suiteId) not started yet, or dropped when the suite stopped */
    status: text("status").$type<AppTestStatus>().notNull().default("running"),
    focus: text("focus").notNull().default(""),
    /** a package of a full test (one module or a few): its suite, place and title */
    suiteId: uuid("suite_id").references((): AnyPgColumn => appTestSuites.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    title: text("title").notNull().default(""),
    moduleIds: jsonb("module_ids").$type<string[]>().notNull().default([]),
    roles: jsonb("roles").$type<string[]>().notNull().default([]),
    summary: text("summary"),
    findings: jsonb("findings").$type<AppTestFinding[]>().notNull().default([]),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    handledBy: uuid("handled_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("app_tests_app").on(t.appId, t.createdAt),
    uniqueIndex("app_tests_task").on(t.taskId),
    index("app_tests_ws_status").on(t.workspaceId, t.status),
    index("app_tests_suite").on(t.suiteId, t.position),
  ],
);

export const APP_TEST_STATUSES = ["queued", "running", "passed", "findings", "error", "cancelled"] as const;
export type AppTestStatus = (typeof APP_TEST_STATUSES)[number];

/**
 * A full test of an app (after AIRIS eda913b): its modules split into packages, each tested in its own session of the
 * same tester, one after the other (the end of one starts the next). One summary when the last ends.
 */
export const appTestSuites = pgTable(
  "app_test_suites",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => appEnvironments.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    status: text("status").$type<"running" | "done" | "stopped">().notNull().default("running"),
    focus: text("focus").notNull().default(""),
    roles: jsonb("roles").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("app_test_suites_app").on(t.appId, t.createdAt), uniqueIndex("app_test_suites_running").on(t.environmentId).where(sql`status = 'running'`)],
);

/** C9: the kinds of an app's documents */
export const APP_DOCUMENT_KINDS = ["prd", "flow", "test_guide", "deck"] as const;
export type AppDocumentKind = (typeof APP_DOCUMENT_KINDS)[number];
export type AppDocumentStatus = "draft" | "approved" | "superseded" | "rejected";

/** C5: a workspace's own UI template: a design system a person pasted (and optionally its CSS tokens), next to the built-in kits. */
export const uiTemplates = pgTable(
  "ui_templates",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mode: text("mode").$type<"light" | "dark">().notNull().default("light"),
    summary: text("summary").notNull().default(""),
    /** the design system for the builders (markdown or a prompt), given to them as data */
    design: text("design").notNull(),
    /** optional :root { --ui-*: … } tokens, for the preview and as the app's variables */
    tokensCss: text("tokens_css").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ui_templates_ws_name").on(t.workspaceId, t.name)],
);

/** C4: a catalog skill's pinned source */
export interface SkillOrigin {
  kind: "github";
  /** owner/repo */
  source: string;
  skillId: string;
  path: string;
  dir: string;
  commit: string;
  license: string | null;
  licenseFile: string | null;
  url: string;
  contentHash: string;
  installs: number | null;
}

/** C4: a task in which the HR employee audits the team's skills (skill_search / skill_inspect / propose_skill granted) */
export const skillAuditTasks = pgTable("skill_audit_tasks", {
  taskId: uuid("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  /** monthly | manual */
  trigger: text("trigger").notNull().default("manual"),
  createdAt: createdAt(),
});

/** C8: what a person decided about a module; every other status is derived (tasks, merges, releases) */
export type AppModuleHold = "paused" | "dropped";
export const APP_MODULE_TASK_ROLES = ["prd", "build", "change", "register"] as const;
export type AppModuleTaskRole = (typeof APP_MODULE_TASK_ROLES)[number];
export interface AppModulePendingWork {
  role: "build" | "change";
  employeeId: string | null;
  teamId: string | null;
  note: string;
  requestedBy: string | null;
  requestedAt: string;
}

/** C8: a module of an app (a part built from its own PRD in the app's repository; released with the app). */
export const appModules = pgTable(
  "app_modules",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    /** technical name, unique in the app (folder/route names follow it) */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    position: integer("position").notNull().default(0),
    hold: text("hold").$type<AppModuleHold>(),
    /** a build or change asked for while another module of the app was being built: started when the app is free */
    pendingWork: jsonb("pending_work").$type<AppModulePendingWork>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("app_modules_slug").on(t.appId, t.slug), index("app_modules_ws").on(t.workspaceId)],
);

/** C8: a task's work for a module (its PRD, a build, a change, or earlier work registered to it). One module per task. */
export const appModuleTasks = pgTable(
  "app_module_tasks",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    moduleId: uuid("module_id").notNull().references(() => appModules.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").$type<AppModuleTaskRole>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("app_module_tasks_module").on(t.moduleId, t.createdAt)],
);

/** C9: one version of an app's document; a new version is a draft next to the approved one. C8: or a module's PRD. */
export const appDocuments = pgTable(
  "app_documents",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
    /** C8: the module this document belongs to (its PRD); null: a document of the whole app */
    moduleId: uuid("module_id").references(() => appModules.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AppDocumentKind>().notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status").$type<AppDocumentStatus>().notNull().default("draft"),
    basedOnVersion: integer("based_on_version"),
    note: text("note").notNull().default(""),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    authorEmployeeId: uuid("author_employee_id").references(() => employees.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    testId: uuid("test_id").references(() => appTests.id, { onDelete: "set null" }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // version numbers count per app (module_id null) and per module
    uniqueIndex("app_documents_version").on(t.appId, t.kind, t.version).where(sql`module_id IS NULL`),
    uniqueIndex("app_documents_module_version").on(t.moduleId, t.kind, t.version).where(sql`module_id IS NOT NULL`),
    index("app_documents_ws_status").on(t.workspaceId, t.status),
  ],
);

/** C9: a task asked to write one of an app's documents (save_app_document is granted for that app and kind only) */
export const appDocumentTasks = pgTable("app_document_tasks", {
  taskId: uuid("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  /** C8: the module whose PRD the task writes (kind prd only) */
  moduleId: uuid("module_id").references(() => appModules.id, { onDelete: "cascade" }),
  kind: text("kind").$type<AppDocumentKind>().notNull(),
  createdAt: createdAt(),
});

/** Database backups of an app environment (B2): taken before a migration, daily (live), by hand, before a restore. */
export const appBackups = pgTable(
  "app_backups",
  {
    id: id(),
    environmentId: uuid("environment_id").notNull().references(() => appEnvironments.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** the helper's backup name (backups/<name>.dump on the server) */
    name: text("name").notNull(),
    kind: text("kind").$type<AppBackupKind>().notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** copied off the server (B2: offsite storage is optional; false until it is configured) */
    offsite: boolean("offsite").notNull().default(false),
    /** pruned on the server (kept as a record) */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    releaseId: uuid("release_id").references(() => appReleases.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("app_backups_env_name").on(t.environmentId, t.name), index("app_backups_env").on(t.environmentId, t.createdAt)],
);

/** Uptime checks of live environments (B3): one row per check, kept UPTIME_RETENTION_DAYS. */
export const appUptimeChecks = pgTable(
  "app_uptime_checks",
  {
    id: id(),
    environmentId: uuid("environment_id").notNull().references(() => appEnvironments.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    /** response time of the successful try, or of the last failed one */
    ms: integer("ms"),
    /** short reason when not ok (timeout, tls, dns, http 502 …) — never response bodies */
    error: text("error"),
  },
  (t) => [index("app_uptime_env_at").on(t.environmentId, t.checkedAt)],
);
