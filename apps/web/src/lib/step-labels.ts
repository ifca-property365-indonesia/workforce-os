import { INCIDENT_KINDS, type GateRule, type IncidentKind } from "@wfos/shared";

const GATE_RULES: readonly GateRule[] = ["not_granted", "reversible", "dry_run", "autonomy_draft", "allow_list", "autonomy", "taint", "leak"];
export type StopReason = "stalled" | "loop";

/** What the Activity Inspector can say about a step beyond its raw name. */
export type StepInfo =
  | { type: "gate"; target: string; rule: GateRule | null; reason: string | null }
  | { type: "incident"; action: string; kind: IncidentKind | null }
  | { type: "repeat" }
  | { type: "stopped"; reason: StopReason }
  /** approval tiers: a division lead's AI review of a sandbox command (employeeId = the run, actor = the reviewer) */
  | { type: "lead_review"; decision: LeadReviewDecision; reviewer: string | null; command: string }
  | { type: "plain" };

export type LeadReviewDecision = "allow" | "deny" | "escalate";
const LEAD_REVIEW_DECISIONS: readonly string[] = ["allow", "deny", "escalate"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** stalled / loop stop reasons, however the worker phrased them: step name, or output.stopped / kind / reason. */
export function stopReason(name: string, output: unknown): StopReason | null {
  const candidates: unknown[] = [name, ...(isObj(output) ? [output.stopped, output.kind, output.reason] : [])];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const m = /(?:^|[_:])(stalled|loop)(?:$|[_:])/.exec(c);
    if (m) return m[1] as StopReason;
  }
  return null;
}

export function describeStep(s: { kind: string; name: string; input: unknown; output: unknown }): StepInfo {
  if (s.name.startsWith("gate:")) {
    const rule = isObj(s.input) && typeof s.input.rule === "string" && (GATE_RULES as readonly string[]).includes(s.input.rule) ? (s.input.rule as GateRule) : null;
    const reason = isObj(s.input) && typeof s.input.reason === "string" ? s.input.reason : null;
    return { type: "gate", target: s.name.slice("gate:".length), rule, reason };
  }
  if (s.name.startsWith("incident_")) {
    const [head, kind] = s.name.split(":");
    const k = kind && (INCIDENT_KINDS as readonly string[]).includes(kind) ? (kind as IncidentKind) : null;
    return { type: "incident", action: head!.slice("incident_".length), kind: k };
  }
  if (s.name === "repeat_detected") return { type: "repeat" };
  if (s.name === "lead_review") {
    const o = isObj(s.output) ? s.output : {};
    const decision = typeof o.decision === "string" && LEAD_REVIEW_DECISIONS.includes(o.decision) ? (o.decision as LeadReviewDecision) : "escalate";
    return { type: "lead_review", decision, reviewer: typeof o.reviewerName === "string" ? o.reviewerName : null, command: isObj(s.input) ? text(s.input.command) : "" };
  }
  if (s.kind === "error" || s.kind === "system" || s.kind === "incident") {
    const r = stopReason(s.name, s.output);
    if (r) return { type: "stopped", reason: r };
  }
  return { type: "plain" };
}

/** A plain-language receipt for one step: a key under employees.activity.receipt plus its values. */
export interface Receipt {
  key: string;
  values: Record<string, string>;
  /** the tool behind it, for steps whose wording names the tool (approval, unknown tools) */
  tool?: string;
}

/** tools whose receipt has its own wording (employees.activity.receipt.<tool>) */
const RECEIPT_TOOLS = new Set([
  "send_email",
  "draft_email",
  "send_invoice",
  "draft_invoice",
  "kb_search",
  "memory_search",
  "memory_save",
  "list_clients",
  "get_client",
  "list_invoices",
  "report_progress",
  "list_tasks",
  "web_fetch",
  "draft_document",
  "create_task",
  "delegate_subtask",
  "request_revision",
  "retry_subtask",
  "reassign_subtask",
  "message_teammate",
  "ask_teammate",
  "git_push",
  "create_pull_request",
  "list_apps",
  "request_preview",
  "request_release",
  "post_webhook",
  "propose_routine",
  "handoff_to_division",
  "finish_review",
]);

/** Claude Code's own tools, as a subagent uses them inside the code lead's sandbox */
const CODE_TOOL_RECEIPT: Record<string, string> = {
  Bash: "code_bash",
  Edit: "code_edit",
  MultiEdit: "code_edit",
  Write: "code_write",
  Read: "code_read",
  Grep: "code_search",
  Glob: "code_search",
  WebFetch: "code_web",
};

/** platform steps with a fixed meaning (employees.activity.receipt.<name>, inspector.stepName.named.<name>) */
export const NAMED_STEPS: ReadonlySet<string> = new Set([
  "subagent_started",
  "subagent_finished",
  "dependencies_done",
  "subtask_blocked",
  "division_budget_cap",
  "waiting_for_prd_decision",
  "waiting_for_preview",
  "preview_deployed",
  "preview_checked",
  "approvals_withdrawn",
  "waiting_for_live",
  "live_deployed",
  "team_review_accepted",
  "team_review_failed",
  "team_review_no_verdict",
  "team_review_unresolved",
  "run_out_of_memory",
  "run_tools_unavailable",
  "tool_unavailable",
]);
/** run failures and refused tool calls with their own wording */
const FAILURE_STEPS = new Set(["run_out_of_memory", "run_tools_unavailable", "tool_unavailable"]);
/** recorded-but-not-run variants: "simulated:send_email", "draft:send_email" */
const MODE_PREFIX = /^(simulated|simulate|draft|drafted):/;

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (v: unknown): string => (typeof v === "string" ? clip(v) : Array.isArray(v) ? clip(v.filter((x) => typeof x === "string").join(", ")) : "");

const base = (p: unknown) => (typeof p === "string" ? clip(p.split("/").filter(Boolean).pop() ?? p) : "");

function toolReceipt(tool: string, input: unknown): Receipt {
  const a = isObj(input) ? input : {};
  const code = CODE_TOOL_RECEIPT[tool];
  if (code) {
    if (code === "code_bash") return { key: code, values: { command: text(a.command) || "—" }, tool };
    if (code === "code_edit" || code === "code_write" || code === "code_read") return { key: code, values: { file: base(a.file_path) || "—" }, tool };
    if (code === "code_search") return { key: code, values: { pattern: text(a.pattern) || "—" }, tool };
    return { key: code, values: { url: text(a.url) || "—" }, tool };
  }
  if (!RECEIPT_TOOLS.has(tool)) return { key: "tool", values: { tool }, tool };
  const values: Record<string, string> = {};
  if (tool === "send_email" || tool === "draft_email") values.to = text(a.to) || "—";
  if (tool === "send_invoice") values.number = text(a.invoiceNumber) || "—";
  if (tool === "web_fetch") values.url = text(a.url) || "—";
  if (tool === "draft_document" || tool === "create_task" || tool === "delegate_subtask" || tool === "create_pull_request") values.title = text(a.title) || "—";
  if (tool === "propose_routine") values.name = text(a.name) || "—";
  if (tool === "handoff_to_division") {
    values.division = text(a.divisionKey) || "—";
    values.title = text(a.title) || "—";
  }
  if (tool === "report_progress") values.percent = typeof a.percent === "number" ? String(Math.round(a.percent)) : "—";
  if (tool === "kb_search" && text(a.query)) return { key: "kb_search_query", values: { query: text(a.query) }, tool };
  return { key: tool, values, tool };
}

/** "Sent an email to …", "Asked for approval: …", "Searched the knowledge base" — what the Activity tab says about a step. */
export function describeReceipt(s: { kind: string; name: string; status?: string; input: unknown; output: unknown }): Receipt {
  const info = describeStep(s);
  if (info.type === "gate") return { key: "gate", values: { target: info.target } };
  if (info.type === "incident") return { key: "incident", values: {} };
  if (info.type === "repeat") return { key: "repeat", values: {} };
  if (info.type === "stopped") return { key: `stopped_${info.reason}`, values: {} };
  if (info.type === "lead_review") return { key: `lead_review_${info.decision}`, values: { reviewer: info.reviewer ?? "—", command: info.command || "—" } };
  if (s.kind === "approval" && s.name.startsWith("approval_requested:")) {
    const tool = s.name.slice("approval_requested:".length);
    return { key: "approval", values: { tool }, tool };
  }
  if (FAILURE_STEPS.has(s.name)) return { key: s.name, values: { tool: isObj(s.input) ? text(s.input.tool) || "—" : "—" } };
  if (s.kind === "tool") return toolReceipt(s.name.replace(MODE_PREFIX, ""), s.input);
  // division work: subagent runs, ordered subtasks, the division budget, a PRD waiting for the owner
  if (s.name === "subagent_started") return { key: "subagent_started", values: { task: isObj(s.input) ? text(s.input.description) || "—" : "—" } };
  if (s.name === "subagent_finished") return { key: s.status === "error" ? "subagent_failed" : "subagent_finished", values: {} };
  if (s.name === "dependencies_done" || s.name === "subtask_blocked" || s.name === "division_budget_cap" || s.name === "waiting_for_prd_decision") return { key: s.name, values: {} };
  if (s.name === "team_review_accepted" || s.name === "team_review_failed" || s.name === "team_review_no_verdict" || s.name === "team_review_unresolved") return { key: s.name, values: {} };
  if (s.kind === "agent_message") return { key: "agent_message", values: { name: clip(s.name) } };
  if (s.kind === "guard") return { key: "guard", values: { name: clip(s.name) } };
  if (s.kind === "llm" || s.kind === "compaction" || s.kind === "budget" || s.kind === "error") return { key: s.kind, values: {} };
  // the platform's own preview steps (A3): waiting for a deploy, and the preview that went live
  if (s.name === "waiting_for_preview") return { key: "waiting_for_preview", values: {} };
  if (s.name === "preview_deployed") return { key: "preview_deployed", values: { url: isObj(s.output) && typeof s.output.url === "string" ? clip(s.output.url) : "" } };
  if (s.name === "preview_checked") {
    const pages = isObj(s.output) && Array.isArray(s.output.pages) ? s.output.pages : [];
    return { key: "preview_checked", values: { pages: String(pages.length), problems: String(pages.filter((p) => isObj(p) && p.problem).length) } };
  }
  if (s.name === "approvals_withdrawn") return { key: "approvals_withdrawn", values: {} };
  if (s.name === "waiting_for_live") return { key: "waiting_for_live", values: {} };
  if (s.name === "live_deployed") return { key: "live_deployed", values: { url: isObj(s.output) && typeof s.output.url === "string" ? clip(s.output.url) : "" } };
  return { key: "other", values: { name: clip(s.name) } };
}
