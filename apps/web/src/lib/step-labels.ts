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
