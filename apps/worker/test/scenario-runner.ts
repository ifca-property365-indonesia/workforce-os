/**
 * Hermetic scenario eval harness. A scenario (test/scenarios/*.json) describes a small world (workspace,
 * employees, teams, tasks, routines, a conversation), one scripted SDK run list per employee, one or more
 * triggers (runTask, runChat, tickRoutines, failTask, a webhook-created task, an approval decision), and a
 * list of expectations. The runner builds the world in the throwaway test database, drives the real entry
 * points against the scripted SDK (src/runner/mock-sdk.ts), freezes the evidence (rows + mock transports),
 * and scores it with pure functions. See docs/EVALS.md.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  approvals,
  conversations,
  createTask,
  db,
  employees,
  incidents,
  messages,
  routineRuns,
  routines,
  steps,
  tasks,
  teamMembers,
  teams,
} from "@wfos/db";
import {
  AUTONOMY_LEVELS,
  EMPLOYEE_STATUSES,
  INCIDENT_KINDS,
  INCIDENT_STATUSES,
  ROUTINE_RUN_STATUSES,
  ROUTING_MODEL,
  TASK_SOURCES,
  TASK_STATUSES,
  TEAM_RESPONDER_MODES,
  allowListEntrySchema,
  applyRunSignals,
  toolPermissionSchema,
} from "@wfos/shared";
import { runTask } from "../src/runner/task";
import { runChat } from "../src/runner/chat";
import { failTask } from "../src/runner/task-status";
import { executeApproval, handleRejection } from "../src/runner/approvals";
import { dispatchRoutine, tickRoutines } from "../src/scheduler/routines";
import { setRunIdleTimeoutMs } from "../src/runner/executor";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockRunner, type MockStep } from "../src/runner/mock-sdk";
import { makeWorkspace, sendUserMessage } from "./fixtures";
import { resetTransport, transport } from "./transport";

// ---------------------------------------------------------------------------
// Scenario format (validated with zod: a malformed file fails with the path of the bad field)
// ---------------------------------------------------------------------------

const Key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "keys are identifiers (letters, digits, _ and -)");

const ToolStep = z.strictObject({
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  error: z.boolean().optional(),
  output: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
/** MockStep, plus `{repeat, step}`: the same tool call n times in a row (loops). */
const Step = z.union([
  z.strictObject({ llm: z.strictObject({ input: z.number(), output: z.number(), text: z.string().optional(), model: z.string().optional() }) }),
  ToolStep,
  z.strictObject({ wait: z.number().int().nonnegative() }),
  z.strictObject({ result: z.string() }),
  z.strictObject({ event: z.record(z.string(), z.unknown()) }),
  z.strictObject({ repeat: z.number().int().min(1).max(50), step: ToolStep }),
]);
type ScenarioStep = z.infer<typeof Step>;

const EmployeeSpec = z.strictObject({
  key: Key,
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).optional(),
  toolPermissions: z.array(toolPermissionSchema).optional(),
  allowList: z.array(allowListEntrySchema).optional(),
  dailyBudget: z.number().positive().optional(),
  specialty: z.string().optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
});

const TeamSpec = z.strictObject({
  key: Key,
  name: z.string().optional(),
  lead: Key.optional(),
  members: z.array(Key).default([]),
  responderMode: z.enum(TEAM_RESPONDER_MODES).optional(),
});

const TaskSpec = z.strictObject({
  key: Key,
  title: z.string().optional(),
  brief: z.string().optional(),
  assignee: Key.optional(),
  team: Key.optional(),
  parent: Key.optional(),
  origin: Key.optional(),
  routine: Key.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  phase: z.string().optional(),
  source: z.enum(TASK_SOURCES).optional(),
  retryCount: z.number().int().nonnegative().optional(),
  untrustedInput: z.boolean().optional(),
  result: z.string().optional(),
  dryRun: z.boolean().optional(),
});

const RoutineSpec = z.strictObject({
  key: Key,
  name: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  brief: z.string().optional(),
  assignee: Key.optional(),
  team: Key.optional(),
  overlap: z.enum(["skip", "queue"]).optional(),
  enabled: z.boolean().optional(),
  untrustedInput: z.boolean().optional(),
  /** next_run_at = now - dueAgoMs (default 60 s: due now, inside the catch-up window) */
  dueAgoMs: z.number().int().optional(),
});

const RoutineRunSpec = z.strictObject({
  routine: Key,
  tasks: z.array(Key).default([]),
  status: z.enum(ROUTINE_RUN_STATUSES).default("dispatched"),
  startedAgoMs: z.number().int().nonnegative().default(86_400_000),
});

const ConversationSpec = z
  .strictObject({ key: Key.default("chat"), employee: Key.optional(), team: Key.optional() })
  .refine((c) => !!c.employee !== !!c.team, "a conversation has exactly one of employee or team");

const Setup = z.strictObject({
  workspace: z.strictObject({ name: z.string().optional(), guardsEnabled: z.boolean().optional(), killSwitch: z.boolean().optional() }).optional(),
  employees: z.array(EmployeeSpec).min(1),
  teams: z.array(TeamSpec).default([]),
  tasks: z.array(TaskSpec).default([]),
  routines: z.array(RoutineSpec).default([]),
  routineRuns: z.array(RoutineRunSpec).default([]),
  conversation: ConversationSpec.optional(),
});

/** a task by setup/webhook key, or by exact title (tasks the run created) */
const TaskRef = z.string().min(1);

const Trigger = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), task: TaskRef, resumeNote: z.string().optional() }),
  z.strictObject({
    kind: z.literal("chat"),
    conversation: Key.optional(),
    content: z.string().min(1),
    mentions: z.array(Key).optional(),
    mentionAll: z.boolean().optional(),
    untrusted: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("routine_tick") }),
  z.strictObject({ kind: z.literal("routine_dispatch"), routine: Key }),
  z.strictObject({
    kind: z.literal("fail_task"),
    task: TaskRef,
    error: z.string().default("Scenario failure"),
    failKind: z.enum(["error", "stalled", "loop", "could_not_start", "orphaned", "approval_failed"]).default("error"),
  }),
  z.strictObject({
    kind: z.literal("webhook_task"),
    key: Key,
    title: z.string().default("Webhook delivery"),
    brief: z.string().min(1),
    assignee: Key.optional(),
    team: Key.optional(),
    /** run it right away (default true) */
    run: z.boolean().default(true),
  }),
  z.strictObject({
    kind: z.literal("decide_approval"),
    /** the latest approval of this tool (any approval when omitted) */
    tool: z.string().optional(),
    decision: z.enum(["approve", "reject"]),
    feedback: z.string().optional(),
  }),
]);
type TriggerSpec = z.infer<typeof Trigger>;

const Expectation = z.looseObject({ scorer: z.string().min(1) });

export const ScenarioSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_]+$/, "scenario names are snake_case"),
  description: z.string().min(1),
  /** per-scenario timeout (default 20 s) */
  timeoutMs: z.number().int().positive().optional(),
  runtime: z.strictObject({ idleTimeoutMs: z.number().int().positive().optional() }).optional(),
  setup: Setup,
  /** per employee key (or "$router" for the team-chat routing classifier): one run's steps, or a list of runs */
  scripts: z.record(z.string(), z.union([z.array(Step), z.array(z.array(Step))])).default({}),
  trigger: z.union([Trigger, z.array(Trigger).min(1)]),
  expect: z.array(Expectation).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ROUTER_KEY = "$router";

// ---------------------------------------------------------------------------
// Evidence: everything the scorers may look at, frozen after the triggers ran
// ---------------------------------------------------------------------------

type TaskRow = typeof tasks.$inferSelect;
export interface ToolCallEvidence {
  who: string;
  tool: string;
  input: Record<string, unknown>;
  permission: "allow" | "deny" | "ask";
  /** the tool result text (for a denied call: the denial message) */
  output?: string;
}
export interface Evidence {
  ids: { workspace: string; employees: Record<string, string>; teams: Record<string, string>; tasks: Record<string, string>; routines: Record<string, string>; conversations: Record<string, string> };
  tasks: TaskRow[];
  approvals: (typeof approvals.$inferSelect)[];
  steps: (typeof steps.$inferSelect)[];
  messages: (typeof messages.$inferSelect)[];
  incidents: (typeof incidents.$inferSelect)[];
  routineRuns: (typeof routineRuns.$inferSelect)[];
  sentMail: { to: string[]; cc: string[]; subject: string }[];
  published: { type: string; [k: string]: unknown }[];
  queued: { queue: string; name: string; data: Record<string, unknown> }[];
  toolCalls: ToolCallEvidence[];
  /** every SDK query: who it was for (employee key or $router), and whether a script was left for it */
  sdkRuns: { who: string; scripted: boolean }[];
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Scorers: pure functions over the frozen evidence → {pass, detail}
// ---------------------------------------------------------------------------

export interface Score {
  pass: boolean;
  detail: string;
}
interface Scorer<A extends z.ZodType> {
  args: A;
  score: (ev: Evidence, args: z.infer<A>) => Score;
}
const scorer = <A extends z.ZodType>(args: A, score: (ev: Evidence, args: z.infer<A>) => Score): Scorer<A> => ({ args, score });

const TAINT_REASON = reasonOf(applyRunSignals({ kind: "run", rule: "allow_list" }, { toolClass: "irreversible", tainted: true }));
const LEAK_REASON = reasonOf(applyRunSignals({ kind: "run", rule: "allow_list" }, { toolClass: "irreversible", tainted: false, highLeak: true }));
function reasonOf(d: { kind: string; reason?: string }): string {
  return d.reason ?? "";
}
/** approvals store the gate's reason, not its rule: map it back (taint / leak / autonomy) */
export function ruleOfReason(reason: string): string {
  if (reason === TAINT_REASON) return "taint";
  if (reason === LEAK_REASON) return "leak";
  if (/^Irreversible action (outside the Owner allow-list requires approval|requires approval \(autonomy )/.test(reason)) return "autonomy";
  return "other";
}

function taskOf(ev: Evidence, ref: string): TaskRow | undefined {
  const id = ev.ids.tasks[ref];
  if (id) return ev.tasks.find((t) => t.id === id);
  const byTitle = ev.tasks.filter((t) => t.title === ref);
  return byTitle.length === 1 ? byTitle[0] : undefined;
}
const taskIdOf = (ev: Evidence, ref: string | undefined) => (ref === undefined ? undefined : (taskOf(ev, ref)?.id ?? `<unknown task ${ref}>`));
const count = (n: number, want: { count?: number; min?: number }) => (want.count !== undefined ? n === want.count : n >= (want.min ?? 1));
const countText = (want: { count?: number; min?: number }) => (want.count !== undefined ? `exactly ${want.count}` : `at least ${want.min ?? 1}`);
const matches = (text: string | undefined, pattern: string | undefined) => pattern === undefined || new RegExp(pattern, "i").test(text ?? "");
const Counted = { count: z.number().int().nonnegative().optional(), min: z.number().int().nonnegative().optional() };
/** partial deep equality: every key of `want` equals the same key of `got` */
function partialEquals(got: unknown, want: unknown): boolean {
  if (want === null || typeof want !== "object") return got === want;
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => partialEquals(got[i], w));
  if (!got || typeof got !== "object") return false;
  return Object.entries(want).every(([k, v]) => partialEquals((got as Record<string, unknown>)[k], v));
}
const brief = (v: unknown) => JSON.stringify(v).slice(0, 160);

export const SCORERS = {
  /** an approval for `tool` exists (optionally: rule taint|leak|autonomy, status, task) */
  approvalCreated: scorer(
    z.strictObject({ tool: z.string(), rule: z.enum(["taint", "leak", "autonomy"]).optional(), status: z.string().optional(), task: TaskRef.optional(), ...Counted }),
    (ev, a) => {
      const taskId = taskIdOf(ev, a.task);
      const hits = ev.approvals.filter(
        (x) => x.toolName === a.tool && (!a.rule || ruleOfReason(x.reason) === a.rule) && (!a.status || x.status === a.status) && (!taskId || x.taskId === taskId),
      );
      const seen = ev.approvals.map((x) => `${x.toolName}/${ruleOfReason(x.reason)}/${x.status}`).join(", ") || "none";
      return { pass: count(hits.length, a), detail: `${hits.length} matching (want ${countText(a)}); approvals: ${seen}` };
    },
  ),
  /** no approval (of `tool`, when given) */
  noApproval: scorer(z.strictObject({ tool: z.string().optional() }), (ev, a) => {
    const hits = ev.approvals.filter((x) => !a.tool || x.toolName === a.tool);
    return { pass: hits.length === 0, detail: hits.length ? `found: ${hits.map((x) => `${x.toolName}/${x.status}`).join(", ")}` : "none" };
  }),
  noMailSent: scorer(z.strictObject({}), (ev) => ({
    pass: ev.sentMail.length === 0,
    detail: ev.sentMail.length ? `sent: ${ev.sentMail.map((m) => m.to.join(",")).join(" | ")}` : "no mail",
  })),
  /** mail went out (to this address, when given) */
  mailSent: scorer(z.strictObject({ to: z.string().optional(), ...Counted }), (ev, a) => {
    const hits = ev.sentMail.filter((m) => !a.to || m.to.includes(a.to) || m.cc.includes(a.to));
    return { pass: count(hits.length, a), detail: `${hits.length} matching (want ${countText(a)}); sent: ${ev.sentMail.map((m) => m.to.join(",")).join(" | ") || "none"}` };
  }),
  taskStatus: scorer(z.strictObject({ task: TaskRef, status: z.enum(TASK_STATUSES) }), (ev, a) => {
    const t = taskOf(ev, a.task);
    return { pass: t?.status === a.status, detail: t ? `${a.task} is ${t.status}${t.error ? ` (${t.error.slice(0, 120)})` : ""}` : `no task ${a.task}` };
  }),
  /** the task is marked untrustedInput (or not, with expected:false) */
  taskTainted: scorer(z.strictObject({ task: TaskRef, expected: z.boolean().default(true) }), (ev, a) => {
    const t = taskOf(ev, a.task);
    return { pass: !!t && t.untrustedInput === a.expected, detail: t ? `${a.task}.untrustedInput = ${t.untrustedInput}` : `no task ${a.task}` };
  }),
  /** partial match on the task row ({{task.x}} templates resolve to ids) */
  taskMatches: scorer(z.strictObject({ task: TaskRef, fields: z.record(z.string(), z.unknown()) }), (ev, a) => {
    const t = taskOf(ev, a.task);
    if (!t) return { pass: false, detail: `no task ${a.task}` };
    const got = Object.fromEntries(Object.keys(a.fields).map((k) => [k, (t as Record<string, unknown>)[k]]));
    return { pass: partialEquals(t, a.fields), detail: `got ${brief(got)}` };
  }),
  /** how many tasks the workspace has (of a routine / source, when given) */
  taskCount: scorer(z.strictObject({ routine: Key.optional(), source: z.enum(TASK_SOURCES).optional(), count: z.number().int().nonnegative() }), (ev, a) => {
    const routineId = a.routine ? ev.ids.routines[a.routine] : undefined;
    const hits = ev.tasks.filter((t) => (!a.routine || t.routineId === routineId) && (!a.source || t.source === a.source));
    return { pass: hits.length === a.count, detail: `${hits.length} tasks (want ${a.count})` };
  }),
  /** a step of this name (optionally status / kind / task) */
  stepRecorded: scorer(z.strictObject({ name: z.string(), status: z.string().optional(), kind: z.string().optional(), task: TaskRef.optional(), ...Counted }), (ev, a) => {
    const taskId = taskIdOf(ev, a.task);
    const named = ev.steps.filter((s) => s.name === a.name && (!taskId || s.taskId === taskId));
    const hits = named.filter((s) => (!a.status || s.status === a.status) && (!a.kind || s.kind === a.kind));
    return { pass: count(hits.length, a), detail: `${hits.length} matching (want ${countText(a)}); "${a.name}" statuses: ${named.map((s) => s.status).join(",") || "none"}` };
  }),
  noStep: scorer(z.strictObject({ name: z.string() }), (ev, a) => {
    const n = ev.steps.filter((s) => s.name === a.name).length;
    return { pass: n === 0, detail: `${n} "${a.name}" steps` };
  }),
  incidentOpened: scorer(z.strictObject({ kind: z.enum(INCIDENT_KINDS), status: z.enum(INCIDENT_STATUSES).optional(), task: TaskRef.optional(), ...Counted }), (ev, a) => {
    const taskId = taskIdOf(ev, a.task);
    const hits = ev.incidents.filter((i) => i.kind === a.kind && (!a.status || i.status === a.status) && (!taskId || i.taskId === taskId));
    return { pass: count(hits.length, a), detail: `${hits.length} matching (want ${countText(a)}); incidents: ${ev.incidents.map((i) => `${i.kind}/${i.status}`).join(", ") || "none"}` };
  }),
  /** assistant replies in the conversation (optionally by employee, routedBy partial match) */
  messageReplies: scorer(
    z.strictObject({ count: z.number().int().nonnegative().optional(), employee: Key.optional(), routedBy: z.record(z.string(), z.unknown()).optional(), untrusted: z.boolean().optional() }),
    (ev, a) => {
      const replies = ev.messages.filter((m) => m.role === "assistant");
      const empId = a.employee ? ev.ids.employees[a.employee] : undefined;
      const hits = replies.filter(
        (m) => (!a.employee || m.employeeId === empId) && (!a.routedBy || partialEquals(m.meta.routedBy, a.routedBy)) && (a.untrusted === undefined || !!m.meta.untrusted === a.untrusted),
      );
      const keyOf = (id: string | null) => Object.entries(ev.ids.employees).find(([, v]) => v === id)?.[0] ?? id;
      const seen = replies.map((m) => `${keyOf(m.employeeId)} ${brief(m.meta.routedBy)}`).join("; ") || "none";
      const want = a.count ?? 1;
      return { pass: a.count !== undefined ? hits.length === want && replies.length === want : hits.length >= 1, detail: `${hits.length} matching of ${replies.length} replies; ${seen}` };
    },
  ),
  /** the scripted model called `tool` (permission allow/deny, output regex, by employee key) */
  toolCall: scorer(
    z.strictObject({ tool: z.string(), permission: z.enum(["allow", "deny"]).optional(), output: z.string().optional(), employee: z.string().optional(), ...Counted }),
    (ev, a) => {
      const named = ev.toolCalls.filter((c) => c.tool === a.tool && (!a.employee || c.who === a.employee));
      const hits = named.filter((c) => (!a.permission || c.permission === a.permission) && matches(c.output, a.output));
      return { pass: count(hits.length, a), detail: `${hits.length} matching of ${named.length} calls (want ${countText(a)}); last output: ${brief(named.at(-1)?.output ?? null)}` };
    },
  ),
  routineRun: scorer(z.strictObject({ routine: Key, status: z.enum(ROUTINE_RUN_STATUSES), ...Counted }), (ev, a) => {
    const id = ev.ids.routines[a.routine];
    const runs = ev.routineRuns.filter((r) => r.routineId === id);
    const hits = runs.filter((r) => r.status === a.status);
    return { pass: count(hits.length, a), detail: `${hits.length} matching (want ${countText(a)}); runs: ${runs.map((r) => r.status).join(",") || "none"}` };
  }),
  eventPublished: scorer(z.strictObject({ type: z.string(), ...Counted }), (ev, a) => {
    const n = ev.published.filter((p) => p.type === a.type).length;
    return { pass: count(n, a), detail: `${n} "${a.type}" events (want ${countText(a)})` };
  }),
  /** a queued job (queue, job name, data.kind, data.taskId by task ref) */
  jobQueued: scorer(z.strictObject({ queue: z.string(), name: z.string().optional(), kind: z.string().optional(), task: TaskRef.optional(), ...Counted }), (ev, a) => {
    const taskId = taskIdOf(ev, a.task);
    const hits = ev.queued.filter((q) => q.queue === a.queue && (!a.name || q.name === a.name) && (!a.kind || q.data.kind === a.kind) && (!taskId || q.data.taskId === taskId));
    return { pass: count(hits.length, a), detail: `${hits.length} matching (want ${countText(a)}) of ${ev.queued.filter((q) => q.queue === a.queue).length} on ${a.queue}` };
  }),
  /** SDK queries made for `who` (employee key or $router) */
  sdkRuns: scorer(z.strictObject({ who: z.string(), ...Counted }), (ev, a) => {
    const n = ev.sdkRuns.filter((r) => r.who === a.who).length;
    return { pass: count(n, a), detail: `${n} runs for ${a.who} (want ${countText(a)}); all: ${ev.sdkRuns.map((r) => r.who).join(",") || "none"}` };
  }),
} satisfies Record<string, Scorer<z.ZodType>>;
export type ScorerName = keyof typeof SCORERS;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");

function formatZod(e: z.ZodError): string {
  return e.issues.map((i) => `  at ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/** Parse + validate one scenario (structure, then every expectation's arguments against its scorer). */
export function parseScenario(raw: unknown, source = "scenario"): Scenario {
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid scenario ${source}:\n${formatZod(parsed.error)}`);
  const s = parsed.data;
  s.expect.forEach((e, i) => {
    const sc = (SCORERS as Record<string, Scorer<z.ZodType>>)[e.scorer];
    if (!sc) throw new Error(`Invalid scenario ${source}: expect[${i}] uses unknown scorer "${e.scorer}" (known: ${Object.keys(SCORERS).join(", ")})`);
    const { scorer: _name, ...args } = e;
    const r = sc.args.safeParse(args);
    if (!r.success) throw new Error(`Invalid scenario ${source}: expect[${i}] (${e.scorer}):\n${formatZod(r.error)}`);
  });
  const keys = new Set<string>();
  for (const k of [...s.setup.employees, ...s.setup.teams, ...s.setup.tasks, ...s.setup.routines].map((x) => x.key)) {
    if (keys.has(k)) throw new Error(`Invalid scenario ${source}: duplicate key "${k}"`);
    keys.add(k);
  }
  const names = s.setup.employees.map((e) => e.name ?? e.key);
  if (new Set(names).size !== names.length) throw new Error(`Invalid scenario ${source}: employee names must be unique (scripts are routed by name)`);
  for (const k of Object.keys(s.scripts)) {
    if (k !== ROUTER_KEY && !s.setup.employees.some((e) => e.key === k)) throw new Error(`Invalid scenario ${source}: scripts.${k} names no employee`);
  }
  return s;
}

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const out = files.map((f) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      throw new Error(`Invalid scenario ${f}: not JSON (${(e as Error).message})`);
    }
    const s = parseScenario(raw, f);
    if (`${s.name}.json` !== f) throw new Error(`Invalid scenario ${f}: name "${s.name}" must match the file name`);
    return s;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type Ids = Evidence["ids"];

/** {{employee.k}} {{task.k}} {{team.k}} {{routine.k}} {{workspace}} → ids, in every string of `v`. */
export function resolveTemplates<T>(v: T, ids: Ids): T {
  const one = (s: string) =>
    s.replace(/\{\{\s*(employee|task|team|routine|conversation)\.([A-Za-z0-9_-]+)\s*\}\}|\{\{\s*workspace\s*\}\}/g, (m, kind?: string, key?: string) => {
      if (!kind) return ids.workspace;
      const map = { employee: ids.employees, task: ids.tasks, team: ids.teams, routine: ids.routines, conversation: ids.conversations }[kind as "task"];
      const id = map[key!];
      if (!id) throw new Error(`template ${m}: no ${kind} "${key}"`);
      return id;
    });
  const walk = (x: unknown): unknown => (typeof x === "string" ? one(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
  return walk(v) as T;
}

function expandSteps(list: ScenarioStep[]): MockStep[] {
  return list.flatMap((s): MockStep[] => ("repeat" in s ? Array.from({ length: s.repeat }, () => ({ ...s.step })) : [s as MockStep]));
}

function systemPromptText(options: Record<string, unknown>): string {
  const sp = options.systemPrompt;
  if (typeof sp === "string") return sp;
  if (sp && typeof sp === "object" && typeof (sp as { append?: unknown }).append === "string") return (sp as { append: string }).append;
  return "";
}

/**
 * One scripted SDK for the whole scenario: the routing classifier (ROUTING_MODEL) gets scripts.$router,
 * every employee run gets that employee's next scripted run (routed by "You are <name>," in its system prompt).
 * An unscripted run replies "Reply from <name>" (enough for chat responders).
 */
function installSdk(s: Scenario, names: Map<string, string>, ids: () => Ids) {
  const queues = new Map<string, MockStep[][]>();
  for (const [who, script] of Object.entries(s.scripts)) {
    const runs = script.length && Array.isArray(script[0]) ? (script as ScenarioStep[][]) : [script as ScenarioStep[]];
    queues.set(who, runs.map(expandSteps));
  }
  const runners: { who: string; runner: MockRunner }[] = [];
  const sdkRuns: Evidence["sdkRuns"] = [];
  const query = ((p: Parameters<QueryFn>[0]) => {
    const options = (p.options ?? {}) as Record<string, unknown>;
    let who: string;
    let fallbackName = "?";
    if (options.model === ROUTING_MODEL) who = ROUTER_KEY;
    else {
      fallbackName = /^You are ([^,]+),/.exec(systemPromptText(options))?.[1] ?? "?";
      who = names.get(fallbackName) ?? `?${fallbackName}`;
    }
    const next = queues.get(who)?.shift();
    sdkRuns.push({ who, scripted: !!next });
    const steps: MockStep[] = next
      ? resolveTemplates(next, ids())
      : who === ROUTER_KEY
        ? [{ result: "{}" }]
        : [{ llm: { input: 10, output: 10, text: `Reply from ${fallbackName}` } }, { result: `Reply from ${fallbackName}` }];
    const runner = mockRunner(steps);
    runners.push({ who, runner });
    return runner.query(p);
  }) as QueryFn;
  setQueryImpl(query);
  return {
    sdkRuns,
    toolCalls: (): ToolCallEvidence[] =>
      runners.flatMap(({ who, runner }) => runner.calls.map((c) => ({
          who,
          tool: c.name,
          input: c.input,
          permission: c.permission.behavior,
          // a denied call's "output" is the denial the model sees
          output: c.output ?? (c.permission.behavior === "deny" ? c.permission.message : undefined),
        }))),
  };
}

async function build(s: Scenario): Promise<{ ids: Ids; names: Map<string, string> }> {
  const ws = await makeWorkspace(s.setup.workspace ?? {});
  const ids: Ids = { workspace: ws.id, employees: {}, teams: {}, tasks: {}, routines: {}, conversations: {} };
  const names = new Map<string, string>();
  const ref = (map: Record<string, string>, kind: string, key: string | undefined) => {
    if (key === undefined) return null;
    const id = map[key];
    if (!id) throw new Error(`scenario ${s.name}: unknown ${kind} "${key}"`);
    return id;
  };
  for (const e of s.setup.employees) {
    const [row] = await db
      .insert(employees)
      .values({
        workspaceId: ws.id,
        name: e.name ?? e.key,
        role: e.role ?? "Staff",
        model: "claude-sonnet-5-5",
        autonomyLevel: e.autonomyLevel ?? "EXECUTE",
        toolPermissions: e.toolPermissions ?? [],
        allowList: e.allowList ?? [],
        dailyBudget: e.dailyBudget ?? 200,
        specialty: e.specialty ?? "",
        status: e.status ?? "ACTIVE",
      })
      .returning();
    ids.employees[e.key] = row!.id;
    names.set(row!.name, e.key);
  }
  for (const t of s.setup.teams) {
    const [row] = await db
      .insert(teams)
      .values({ workspaceId: ws.id, name: t.name ?? t.key, leadId: ref(ids.employees, "employee", t.lead), responderMode: t.responderMode ?? "lead" })
      .returning();
    ids.teams[t.key] = row!.id;
    const members = [...new Set([...(t.lead ? [t.lead] : []), ...t.members])];
    if (members.length) await db.insert(teamMembers).values(members.map((m) => ({ teamId: row!.id, employeeId: ref(ids.employees, "employee", m)! })));
  }
  const now = Date.now();
  for (const r of s.setup.routines) {
    const [row] = await db
      .insert(routines)
      .values({
        workspaceId: ws.id,
        name: r.name ?? r.key,
        cron: r.cron ?? "0 9 * * *",
        timezone: r.timezone ?? "Asia/Jakarta",
        brief: r.brief ?? "Routine work",
        assigneeId: ref(ids.employees, "employee", r.assignee),
        teamId: ref(ids.teams, "team", r.team),
        overlap: r.overlap ?? "skip",
        enabled: r.enabled ?? true,
        untrustedInput: r.untrustedInput ?? false,
        nextRunAt: new Date(now - (r.dueAgoMs ?? 60_000)),
      })
      .returning();
    ids.routines[r.key] = row!.id;
  }
  // tasks in file order: a parent / origin must come before the tasks that reference it
  for (const t of s.setup.tasks) {
    const [row] = await db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        title: t.title ?? t.key,
        brief: t.brief ?? "Do it",
        assigneeId: ref(ids.employees, "employee", t.assignee),
        teamId: ref(ids.teams, "team", t.team),
        parentTaskId: ref(ids.tasks, "task", t.parent),
        originTaskId: ref(ids.tasks, "task", t.origin),
        routineId: ref(ids.routines, "routine", t.routine),
        status: t.status ?? "QUEUED",
        phase: t.phase ?? null,
        source: t.source ?? (t.routine ? "routine" : t.parent ? "team" : "board"),
        retryCount: t.retryCount ?? 0,
        untrustedInput: t.untrustedInput ?? false,
        result: t.result ?? null,
        dryRun: t.dryRun ?? false,
      })
      .returning();
    ids.tasks[t.key] = row!.id;
  }
  for (const rr of s.setup.routineRuns) {
    await db.insert(routineRuns).values({
      routineId: ref(ids.routines, "routine", rr.routine)!,
      taskIds: rr.tasks.map((k) => ref(ids.tasks, "task", k)!),
      status: rr.status,
      startedAt: new Date(now - rr.startedAgoMs),
    });
  }
  const c = s.setup.conversation;
  if (c) {
    const [row] = await db
      .insert(conversations)
      .values({ workspaceId: ws.id, employeeId: ref(ids.employees, "employee", c.employee), teamId: ref(ids.teams, "team", c.team) })
      .returning();
    ids.conversations[c.key] = row!.id;
  }
  return { ids, names };
}

async function taskIdByRef(ids: Ids, ref: string): Promise<string> {
  if (ids.tasks[ref]) return ids.tasks[ref];
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, ids.workspace), eq(tasks.title, ref)));
  if (rows.length !== 1) throw new Error(`trigger: task "${ref}" matches ${rows.length} tasks (by key or exact title)`);
  return rows[0]!.id;
}

async function fire(t: TriggerSpec, ids: Ids): Promise<void> {
  switch (t.kind) {
    case "task":
      return runTask(await taskIdByRef(ids, t.task), t.resumeNote);
    case "chat": {
      const convId = t.conversation ? ids.conversations[t.conversation] : Object.values(ids.conversations)[0];
      if (!convId) throw new Error("chat trigger: the scenario has no setup.conversation");
      const meta = {
        ...(t.mentions?.length ? { mentions: t.mentions.map((k) => ids.employees[k] ?? `<unknown ${k}>`) } : {}),
        ...(t.mentionAll ? { mentionAll: true } : {}),
        ...(t.untrusted ? { untrusted: true } : {}),
      };
      const m = await sendUserMessage(convId, { content: t.content, meta });
      return runChat(convId, m.id);
    }
    case "routine_tick":
      return tickRoutines(new Date());
    case "routine_dispatch": {
      const [r] = await db.select().from(routines).where(eq(routines.id, ids.routines[t.routine]!));
      await dispatchRoutine(r!, "manual");
      return;
    }
    case "fail_task":
      await failTask({ id: await taskIdByRef(ids, t.task) }, t.error, { kind: t.failKind });
      return;
    case "webhook_task": {
      // the same call as POST /api/hooks/:id (apps/web): a webhook payload is untrusted input
      const task = await createTask(db, {
        workspaceId: ids.workspace,
        title: t.title,
        brief: t.brief,
        assigneeId: t.assignee ? ids.employees[t.assignee] : null,
        teamId: t.team ? ids.teams[t.team] : null,
        source: "webhook",
        untrustedInput: true,
      });
      ids.tasks[t.key] = task.id;
      if (t.run) await runTask(task.id);
      return;
    }
    case "decide_approval": {
      const rows = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.workspaceId, ids.workspace), eq(approvals.status, "PENDING"), ...(t.tool ? [eq(approvals.toolName, t.tool)] : [])))
        .orderBy(asc(approvals.createdAt));
      const a = rows.at(-1);
      if (!a) throw new Error(`decide_approval: no PENDING approval${t.tool ? ` for ${t.tool}` : ""}`);
      if (t.decision === "approve") {
        await db.update(approvals).set({ status: "APPROVED", decidedAt: new Date() }).where(eq(approvals.id, a.id));
        await executeApproval(a.id);
      } else {
        await db.update(approvals).set({ status: "REJECTED", decidedAt: new Date(), feedback: t.feedback ?? null }).where(eq(approvals.id, a.id));
        await handleRejection(a.id);
      }
      return;
    }
  }
}

async function collect(ids: Ids, sdk: ReturnType<typeof installSdk>): Promise<Evidence> {
  const ws = ids.workspace;
  const convIds = (await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, ws))).map((c) => c.id);
  const routineIds = (await db.select({ id: routines.id }).from(routines).where(eq(routines.workspaceId, ws))).map((r) => r.id);
  const taskRows = await db.select().from(tasks).where(eq(tasks.workspaceId, ws)).orderBy(asc(tasks.createdAt));
  const inWs = (data: Record<string, unknown>) =>
    data.workspaceId === ws || (typeof data.taskId === "string" && taskRows.some((t) => t.id === data.taskId)) || (typeof data.conversationId === "string" && convIds.includes(data.conversationId));
  const ev: Evidence = {
    ids: structuredClone(ids),
    tasks: taskRows,
    approvals: await db.select().from(approvals).where(eq(approvals.workspaceId, ws)).orderBy(asc(approvals.createdAt)),
    steps: await db.select().from(steps).where(eq(steps.workspaceId, ws)).orderBy(asc(steps.createdAt)),
    messages: convIds.length ? await db.select().from(messages).where(inArray(messages.conversationId, convIds)).orderBy(asc(messages.createdAt), asc(messages.id)) : [],
    incidents: await db.select().from(incidents).where(eq(incidents.workspaceId, ws)).orderBy(asc(incidents.createdAt)),
    routineRuns: routineIds.length ? await db.select().from(routineRuns).where(or(...routineIds.map((id) => eq(routineRuns.routineId, id)))).orderBy(asc(routineRuns.startedAt)) : [],
    // the mock transports are process-wide (reset per scenario); queued jobs and events are filtered to this workspace
    sentMail: transport.mails.map((m) => ({ to: [...m.mail.to], cc: [...(m.mail.cc ?? [])], subject: m.mail.subject })),
    published: transport.published.filter((p) => p.workspaceId === ws).map((p) => structuredClone(p.ev) as Evidence["published"][number]),
    queued: transport.queued.map((q) => ({ queue: q.queue, name: q.name, data: structuredClone(q.data) as Record<string, unknown> })).filter((q) => inWs(q.data)),
    toolCalls: structuredClone(sdk.toolCalls()),
    sdkRuns: structuredClone(sdk.sdkRuns),
  };
  return deepFreeze(ev);
}

export interface ScenarioResult {
  name: string;
  scores: (Score & { scorer: string; args: Record<string, unknown> })[];
  pass: boolean;
  evidence: Evidence;
}

/** Score already-collected evidence (pure). */
export function scoreEvidence(s: Scenario, ev: Evidence): ScenarioResult["scores"] {
  return s.expect.map((e) => {
    const { scorer: name, ...rawArgs } = e;
    const sc = (SCORERS as Record<string, Scorer<z.ZodType>>)[name]!;
    const args = resolveTemplates(rawArgs, ev.ids);
    try {
      return { scorer: name, args, ...sc.score(ev, sc.args.parse(args)) };
    } catch (err) {
      return { scorer: name, args, pass: false, detail: `scorer threw: ${(err as Error).message}` };
    }
  });
}

/** Build the world, fire the triggers, freeze the evidence, score it. */
export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  resetTransport();
  if (s.runtime?.idleTimeoutMs) setRunIdleTimeoutMs(s.runtime.idleTimeoutMs);
  try {
    const { ids, names } = await build(s);
    const sdk = installSdk(s, names, () => ids);
    for (const t of Array.isArray(s.trigger) ? s.trigger : [s.trigger]) await fire(resolveTemplates(t, ids), ids);
    const evidence = await collect(ids, sdk);
    const scores = scoreEvidence(s, evidence);
    return { name: s.name, scores, pass: scores.every((x) => x.pass), evidence };
  } finally {
    setQueryImpl(null);
    setRunIdleTimeoutMs(null);
  }
}

/** Compact score table (one line per expectation). */
export function scoreTable(r: Pick<ScenarioResult, "name" | "scores">): string {
  const rows = r.scores.map((x) => {
    const args = Object.entries(x.args)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    return `  ${x.pass ? "PASS" : "FAIL"}  ${`${x.scorer} ${args}`.slice(0, 90).padEnd(90)}  ${x.detail}`;
  });
  const passed = r.scores.filter((x) => x.pass).length;
  return [`scenario ${r.name}: ${passed}/${r.scores.length} expectations passed`, ...rows].join("\n");
}
