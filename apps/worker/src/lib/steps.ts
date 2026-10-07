import { db, steps, tasks, type DB } from "@wfos/db";
import type { StepDTO, StepKind } from "@wfos/shared";
import { eq, sql } from "drizzle-orm";
import { publish } from "./redis";

export interface StepRecord {
  workspaceId: string;
  taskId?: string | null;
  conversationId?: string | null;
  employeeId?: string | null;
  kind: StepKind;
  name: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
  credits?: number;
  input?: unknown;
  output?: unknown;
  status?: string;
}

function trimJson(v: unknown, max = 20000): unknown {
  if (v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s && s.length > max) return { truncated: true, preview: s.slice(0, max) };
  return v;
}

/** Persist an Activity step, add its cost to the task, and stream it to the UI. */
export async function recordStep(r: StepRecord, database: DB = db): Promise<StepDTO> {
  const [row] = await database
    .insert(steps)
    .values({
      workspaceId: r.workspaceId,
      taskId: r.taskId ?? null,
      conversationId: r.conversationId ?? null,
      employeeId: r.employeeId ?? null,
      kind: r.kind,
      name: r.name,
      model: r.model ?? null,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
      latencyMs: Math.round(r.latencyMs ?? 0),
      credits: r.credits ?? 0,
      input: trimJson(r.input),
      output: trimJson(r.output),
      status: r.status ?? "ok",
    })
    .returning();
  if (r.taskId && (r.credits ?? 0) > 0) {
    await database.update(tasks).set({ costCredits: sql`${tasks.costCredits} + ${r.credits}` }).where(eq(tasks.id, r.taskId));
  }
  const dto: StepDTO = {
    id: row!.id,
    taskId: row!.taskId,
    employeeId: row!.employeeId,
    kind: row!.kind,
    name: row!.name,
    model: row!.model,
    inputTokens: row!.inputTokens,
    outputTokens: row!.outputTokens,
    latencyMs: row!.latencyMs,
    credits: row!.credits,
    input: row!.input,
    output: row!.output,
    status: row!.status,
    createdAt: row!.createdAt.toISOString(),
  };
  await publish(r.workspaceId, { type: "step.created", taskId: r.taskId ?? null, conversationId: r.conversationId ?? null, step: dto });
  return dto;
}
