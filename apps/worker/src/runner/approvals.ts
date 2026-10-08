import { and, eq } from "drizzle-orm";
import { approvals, audit, db, memories, tasks, workspaces } from "@wfos/db";
import type { Deliverable } from "@wfos/db";
import { recordStep } from "../lib/steps";
import { enqueueTask, publish } from "../lib/redis";
import { embedOne } from "../lib/embeddings";
import { log } from "../lib/logger";
import { executeAction } from "../tools/actions";
import { TOOL_BY_NAME } from "@wfos/shared";
import { notifyFinished } from "./task";
import { onChildFinished } from "../orchestration/team";
import { sql } from "drizzle-orm";

/** Execute an APPROVED action with the exact (possibly edited) payload. Idempotent per approval. */
export async function executeApproval(approvalId: string): Promise<void> {
  // Claim first (APPROVED → EXECUTING) so concurrent or retried jobs can never execute the same action twice.
  const [a] = await db
    .update(approvals)
    .set({ status: "EXECUTING" })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "APPROVED")))
    .returning();
  if (!a) return;
  const payload = (a.editedPayload ?? a.payload) as Record<string, unknown>;
  const [task] = a.taskId ? await db.select().from(tasks).where(eq(tasks.id, a.taskId)) : [];
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId));
  const simulated = !!task?.dryRun || task?.source === "demo" || !!ws?.killSwitch;
  const started = Date.now();
  let result: { ok: boolean; summary: string; details?: Record<string, unknown> };
  if (ws?.killSwitch) {
    result = { ok: false, summary: "Kill switch engaged: action not executed." };
  } else if (task?.status === "CANCELLED") {
    result = { ok: false, summary: "Task was cancelled: action not executed." };
  } else if (simulated) {
    result = { ok: true, summary: `DRY RUN: ${a.toolName} would have been executed now.`, details: { simulated: true } };
  } else {
    try {
      result = await executeAction(a.workspaceId, a.toolName, payload, { taskId: a.taskId, employeeId: a.employeeId });
    } catch (e) {
      result = { ok: false, summary: (e as Error).message };
    }
  }
  const status = result.ok ? "EXECUTED" : "FAILED";
  const updated = await db
    .update(approvals)
    .set({ status, executionResult: result })
    .where(and(eq(approvals.id, a.id), eq(approvals.status, "EXECUTING")))
    .returning({ id: approvals.id });
  if (!updated.length) return;
  await recordStep({
    workspaceId: a.workspaceId,
    taskId: a.taskId,
    employeeId: a.employeeId,
    kind: "tool",
    name: simulated ? `simulated:${a.toolName}` : a.toolName,
    latencyMs: Date.now() - started,
    credits: result.ok && !simulated ? (TOOL_BY_NAME[a.toolName]?.credits ?? 0.5) : 0,
    input: payload,
    output: result,
    status: simulated ? "simulated" : result.ok ? "ok" : "error",
  });
  if (task && simulated && result.ok) {
    const d: Deliverable = {
      id: crypto.randomUUID(),
      kind: "simulated_action",
      title: `[DRY RUN] ${a.title}`,
      content: JSON.stringify(payload, null, 2),
      meta: { toolName: a.toolName, approvalId: a.id },
      createdAt: new Date().toISOString(),
    };
    await db.update(tasks).set({ deliverables: sql`${tasks.deliverables} || ${JSON.stringify([d])}::jsonb` }).where(eq(tasks.id, task.id));
  }
  await audit({ workspaceId: a.workspaceId, actorLabel: "system", action: `approval.${status.toLowerCase()}`, targetType: "approval", targetId: a.id, details: { toolName: a.toolName, summary: result.summary } });
  await publish(a.workspaceId, { type: "approval.updated", approvalId: a.id, status });
  if (a.taskId) await afterApprovalResolved(a.taskId);
}

/** Rejection feedback is written to the employee's memory, then the task continues. */
export async function handleRejection(approvalId: string): Promise<void> {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a || a.status !== "REJECTED") return;
  if (a.feedback && a.employeeId) {
    const content = `Rejected "${a.title}" (${a.toolName}). Reviewer feedback: ${a.feedback}`;
    let embedding: number[] | null = null;
    try {
      embedding = await embedOne(content);
    } catch (e) {
      log.warn({ err: e }, "embedding failed for rejection memory");
    }
    await db.insert(memories).values({ workspaceId: a.workspaceId, employeeId: a.employeeId, kind: "feedback", source: "rejection", content, embedding });
    await recordStep({ workspaceId: a.workspaceId, taskId: a.taskId, employeeId: a.employeeId, kind: "system", name: "feedback_written_to_memory", output: content });
  }
  if (a.taskId) await afterApprovalResolved(a.taskId);
}

/** When the last pending approval of a task is resolved: revise (if rejected with feedback) or close. */
export async function afterApprovalResolved(taskId: string): Promise<void> {
  // Row lock so concurrent approval jobs cannot both resolve the same task.
  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!task || task.status !== "AWAITING_APPROVAL") return null;
    const all = await tx.select().from(approvals).where(eq(approvals.taskId, taskId));
    if (all.some((x) => x.status === "PENDING" || x.status === "APPROVED" || x.status === "EXECUTING")) return null;

    const consumed = (x: (typeof all)[number]) => !!(x.executionResult as { consumed?: boolean } | null)?.consumed;
    const needsRevision = all.filter((x) => x.status === "REJECTED" && x.feedback && !consumed(x));
    // Workspace mode: approved commands ran on the agent's behalf; it continues with their output
    const commandResults = all.filter((x) => x.toolName === "bash" && (x.status === "EXECUTED" || x.status === "FAILED") && !consumed(x));
    if (needsRevision.length || commandResults.length) {
      for (const r of needsRevision) await tx.update(approvals).set({ executionResult: { consumed: true } }).where(eq(approvals.id, r.id));
      for (const r of commandResults) {
        await tx.update(approvals).set({ executionResult: { ...(r.executionResult ?? {}), consumed: true } }).where(eq(approvals.id, r.id));
      }
      await tx.update(tasks).set({ status: "QUEUED" }).where(eq(tasks.id, task.id));
      const note = [
        ...needsRevision.map((r) => `- Your proposed "${r.title}" was REJECTED. Feedback: ${r.feedback}`),
        ...commandResults.map((r) => {
          const d = (r.executionResult as { summary?: string; details?: { output?: string } } | null) ?? {};
          const out = String(d.details?.output ?? "").slice(-8000);
          return `- Approved command \`${String((r.editedPayload ?? r.payload).command ?? "")}\` ${d.summary ?? r.status}. Output:\n\`\`\`\n${out}\n\`\`\``;
        }),
      ].join("\n");
      return { kind: "revise" as const, task, note };
    }
    const summary = all
      .map((x) => `- ${x.title}: ${x.status}${(x.executionResult as { summary?: string } | null)?.summary ? ` — ${(x.executionResult as { summary?: string }).summary}` : ""}`)
      .join("\n");
    const result = `${task.result ?? ""}\n\nApproval outcomes:\n${summary}`.trim();
    const failed = all.some((x) => x.status === "FAILED");
    const status = failed ? ("FAILED" as const) : ("DONE" as const);
    await tx
      .update(tasks)
      .set({ status, result, completedAt: new Date(), error: failed ? "One or more approved actions failed to execute." : null })
      .where(eq(tasks.id, task.id));
    return { kind: "close" as const, task, status, result };
  });
  if (!outcome) return;
  const { task } = outcome;
  if (outcome.kind === "revise") {
    await publish(task.workspaceId, { type: "task.updated", taskId: task.id, status: "QUEUED", employeeId: task.assigneeId, title: task.title });
    await enqueueTask(task.id, task.workspaceId, `${outcome.note}\nContinue the task: revise and propose again where appropriate.`);
    return;
  }
  await publish(task.workspaceId, { type: "task.updated", taskId: task.id, status: outcome.status, employeeId: task.assigneeId, title: task.title });
  await notifyFinished(task, outcome.status, outcome.result);
  if (task.parentTaskId) await onChildFinished(task.workspaceId, task.parentTaskId);
}
