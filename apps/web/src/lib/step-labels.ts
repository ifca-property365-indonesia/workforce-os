import { INCIDENT_KINDS, type GateRule, type IncidentKind } from "@wfos/shared";

const GATE_RULES: readonly GateRule[] = ["not_granted", "reversible", "dry_run", "autonomy_draft", "allow_list", "autonomy", "taint", "leak"];
export type StopReason = "stalled" | "loop";

/** What the Activity Inspector can say about a step beyond its raw name. */
export type StepInfo =
  | { type: "gate"; target: string; rule: GateRule | null; reason: string | null }
  | { type: "incident"; action: string; kind: IncidentKind | null }
  | { type: "repeat" }
  | { type: "stopped"; reason: StopReason }
  | { type: "plain" };

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
  "list_tasks",
  "web_fetch",
  "draft_document",
  "create_task",
  "delegate_subtask",
  "request_revision",
  "retry_subtask",
  "reassign_subtask",
  "message_teammate",
  "git_push",
  "create_pull_request",
  "post_webhook",
  "propose_routine",
]);
/** recorded-but-not-run variants: "simulated:send_email", "draft:send_email" */
const MODE_PREFIX = /^(simulated|simulate|draft|drafted):/;

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (v: unknown): string => (typeof v === "string" ? clip(v) : Array.isArray(v) ? clip(v.filter((x) => typeof x === "string").join(", ")) : "");

function toolReceipt(tool: string, input: unknown): Receipt {
  const a = isObj(input) ? input : {};
  if (!RECEIPT_TOOLS.has(tool)) return { key: "tool", values: { tool }, tool };
  const values: Record<string, string> = {};
  if (tool === "send_email" || tool === "draft_email") values.to = text(a.to) || "—";
  if (tool === "send_invoice") values.number = text(a.invoiceNumber) || "—";
  if (tool === "web_fetch") values.url = text(a.url) || "—";
  if (tool === "draft_document" || tool === "create_task" || tool === "delegate_subtask" || tool === "create_pull_request") values.title = text(a.title) || "—";
  if (tool === "propose_routine") values.name = text(a.name) || "—";
  if (tool === "kb_search" && text(a.query)) return { key: "kb_search_query", values: { query: text(a.query) }, tool };
  return { key: tool, values, tool };
}

/** "Sent an email to …", "Asked for approval: …", "Searched the knowledge base" — what the Activity tab says about a step. */
export function describeReceipt(s: { kind: string; name: string; input: unknown; output: unknown }): Receipt {
  const info = describeStep(s);
  if (info.type === "gate") return { key: "gate", values: { target: info.target } };
  if (info.type === "incident") return { key: "incident", values: {} };
  if (info.type === "repeat") return { key: "repeat", values: {} };
  if (info.type === "stopped") return { key: `stopped_${info.reason}`, values: {} };
  if (s.kind === "approval" && s.name.startsWith("approval_requested:")) {
    const tool = s.name.slice("approval_requested:".length);
    return { key: "approval", values: { tool }, tool };
  }
  if (s.kind === "tool") return toolReceipt(s.name.replace(MODE_PREFIX, ""), s.input);
  if (s.kind === "agent_message") return { key: "agent_message", values: { name: clip(s.name) } };
  if (s.kind === "guard") return { key: "guard", values: { name: clip(s.name) } };
  if (s.kind === "llm" || s.kind === "compaction" || s.kind === "budget" || s.kind === "error") return { key: s.kind, values: {} };
  return { key: "other", values: { name: clip(s.name) } };
}
