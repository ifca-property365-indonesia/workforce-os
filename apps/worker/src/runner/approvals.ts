import { and, eq } from "drizzle-orm";
import { approvals, audit, db, memories, messages, tasks, workspaces } from "@wfos/db";
import type { Deliverable } from "@wfos/db";
import { recordStep } from "../lib/steps";
import { enqueueTask, publish } from "../lib/redis";
import { embedOne } from "../lib/embeddings";
import { log } from "../lib/logger";
import { executeAction } from "../tools/actions";
import { TOOL_BY_NAME } from "@wfos/shared";
import { afterTerminal, failTask } from "./task-status";
import { errorMessage } from "../lib/errors";
import { sql } from "drizzle-orm";
import { msg } from "@wfos/shared/messages";
import { workspaceLocale } from "../lib/settings";
import { chatMessageDto } from "./chat-turns";
import { redactSecrets } from "@wfos/shared/server";
import { approvalTainted } from "./taint";

type ApprovalRow = typeof approvals.$inferSelect;

/** Receipt text limits: the summary / error of an action and a reviewer's feedback. */
export const RECEIPT_SUMMARY_CHARS = 300;
export const RECEIPT_FEEDBACK_CHARS = 500;

/**
 * Untrusted text (tool output, reviewer feedback) made safe for a one-line receipt that later
 * agents read in the transcript: secrets redacted, newlines flattened, length capped.
 */
export function receiptText(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A chat approval (raised in a conversation, no task) reports its outcome back into that
 * conversation as a system message. Best-effort: a failure is logged and never undoes or blocks
 * the decision itself.
 */
async function postChatReceipt(a: ApprovalRow, outcome: { kind: "executed" | "failed"; summary: string } | { kind: "rejected" }): Promise<void> {
  if (!a.conversationId || a.taskId) return;
  try {
    // a retried job must not post the same receipt twice
    const [already] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, a.conversationId), eq(messages.role, "system"), sql`${messages.meta} @> ${JSON.stringify({ approvalId: a.id })}::jsonb`))
      .limit(1);
    if (already) return;
    const locale = await workspaceLocale(a.workspaceId);
    const title = receiptText(a.title, RECEIPT_SUMMARY_CHARS);
    const summary = outcome.kind === "rejected" ? "" : receiptText(outcome.summary, RECEIPT_SUMMARY_CHARS);
    const feedback = a.feedback ? receiptText(a.feedback, RECEIPT_FEEDBACK_CHARS) : "";
    const content =
      outcome.kind === "executed"
        ? msg(locale, "receipt.executed", { title, summary })
        : outcome.kind === "failed"
          ? msg(locale, "receipt.failed", { title, error: summary })
          : msg(locale, "receipt.rejected", { title }) + (feedback ? `\n${msg(locale, "receipt.feedback", { feedback })}` : "");
    const [m] = await db
      .insert(messages)
      .values({
        conversationId: a.conversationId,
        role: "system",
        content,
        employeeId: a.employeeId,
        handledAt: new Date(),
        // the title (and the tool output) come from a run that handled untrusted content: fenced and tainting later turns
        meta: { approvalId: a.id, ...((await approvalTainted(a)) ? { untrusted: true } : {}) },
      })
      .returning();
    await publish(a.workspaceId, { type: "chat.message", conversationId: a.conversationId, message: chatMessageDto(m!) });
  } catch (e) {
    log.warn({ err: e, approvalId: a.id, conversationId: a.conversationId }, "chat receipt for approval failed");
  }
}

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
      // the taint mark is read from the payload the run wrote, never from the human-edited copy
      result = await executeAction(a.workspaceId, a.toolName, payload, { taskId: a.taskId, employeeId: a.employeeId, untrusted: a.payload.untrustedInput === true });
    } catch (e) {
      result = { ok: false, summary: errorMessage(e) };
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
    conversationId: a.conversationId,
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
  await postChatReceipt(a, { kind: result.ok ? "executed" : "failed", summary: result.summary });
  if (a.taskId) await afterApprovalResolved(a.taskId);
}

/** Rejection feedback is written to the employee's memory, then the task continues. */
export async function handleRejection(approvalId: string): Promise<void> {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a || a.status !== "REJECTED") return;
  if (a.feedback && a.employeeId) {
    // the reviewer's feedback is trusted human input; the title was written by the run: when that run handled
    // untrusted content it is left out, so a trusted feedback memory cannot carry an injection
    const content = (await approvalTainted(a))
      ? `Rejected a proposed ${a.toolName} action. Reviewer feedback: ${a.feedback}`
      : `Rejected "${a.title}" (${a.toolName}). Reviewer feedback: ${a.feedback}`;
    let embedding: number[] | null = null;
    try {
      embedding = await embedOne(content);
    } catch (e) {
      log.warn({ err: e }, "embedding failed for rejection memory");
    }
    await db.insert(memories).values({ workspaceId: a.workspaceId, employeeId: a.employeeId, kind: "feedback", source: "rejection", content, embedding });
    await recordStep({ workspaceId: a.workspaceId, taskId: a.taskId, conversationId: a.conversationId, employeeId: a.employeeId, kind: "system", name: "feedback_written_to_memory", output: content });
  }
  await postChatReceipt(a, { kind: "rejected" });
  if (a.taskId) await afterApprovalResolved(a.taskId);
}

/**
 * When the last pending approval of a task is resolved: revise (if rejected with feedback) or close.
 * Idempotent: it only acts on an AWAITING_APPROVAL task (row-locked) with no open approval, and the
 * outcome moves the task out of AWAITING_APPROVAL in the same transaction (revise / DONE) or right
 * after it through failTask (conditional on AWAITING_APPROVAL). So calling it again, concurrently,
 * or from the reaper for a task whose resolver died, is harmless.
 */
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
    // a failed push or pull request (conflict, rejected, branch moved) goes back to the employee, not a silent failure
    const deliveryFailures = all.filter((x) => (x.toolName === "git_push" || x.toolName === "create_pull_request") && x.status === "FAILED" && !consumed(x));
    for (const r of deliveryFailures) commandResults.push(r);
    if (needsRevision.length || commandResults.length) {
      for (const r of needsRevision) await tx.update(approvals).set({ executionResult: { consumed: true } }).where(eq(approvals.id, r.id));
      for (const r of commandResults) {
        await tx.update(approvals).set({ executionResult: { ...(r.executionResult ?? {}), consumed: true } }).where(eq(approvals.id, r.id));
      }
      await tx.update(tasks).set({ status: "QUEUED" }).where(eq(tasks.id, task.id));
      const note = [
        ...needsRevision.map((r) => `- Your proposed "${r.title}" was REJECTED. Feedback: ${r.feedback}`),
        ...commandResults.map((r) => {
          if (r.toolName !== "bash") {
            const d = (r.executionResult as { summary?: string } | null) ?? {};
            return `- ${r.toolName === "git_push" ? "Pushing your branch" : "Opening the pull request"} FAILED: ${d.summary ?? "unknown error"}. Fix the cause (for conflicts: rebase onto upstream/<default branch>, which is up to date), commit, and call ${r.toolName} again.`;
          }
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
    // a failure is written after commit by failTask (conditional on AWAITING_APPROVAL, so a concurrent resolver is a no-op)
    if (all.some((x) => x.status === "FAILED")) return { kind: "fail" as const, task, result };
    const [done] = await tx.update(tasks).set({ status: "DONE", result, completedAt: new Date(), error: null }).where(eq(tasks.id, task.id)).returning();
    return { kind: "close" as const, task: done! };
  });
  if (!outcome) return;
  const { task } = outcome;
  if (outcome.kind === "revise") {
    await publish(task.workspaceId, { type: "task.updated", taskId: task.id, status: "QUEUED", employeeId: task.assigneeId, title: task.title });
    await enqueueTask(task.id, task.workspaceId, `${outcome.note}\nContinue the task: revise and propose again where appropriate.`);
    return;
  }
  if (outcome.kind === "fail") {
    await failTask(task, "One or more approved actions failed to execute.", { kind: "approval_failed", result: outcome.result, onlyIfStatus: ["AWAITING_APPROVAL"] });
    return;
  }
  await afterTerminal(task, "DONE");
}
