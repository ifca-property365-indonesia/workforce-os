import { memorySnapshot, recordMemoryEvent } from "../lib/memory-journal";
import { and, eq, inArray } from "drizzle-orm";
import { approvals, apps, appReleases, audit, db, employees, memories, messages, steps, tasks, workspaces } from "@wfos/db";
import type { Deliverable } from "@wfos/db";
import { recordStep } from "../lib/steps";
import { enqueueTask, publish } from "../lib/redis";
import { embedOne } from "../lib/embeddings";
import { log } from "../lib/logger";
import { executeAction } from "../tools/actions";
import { PREVIEW_MAX_FAILED_ATTEMPTS, TERMINAL_STATUSES, TOOL_BY_NAME } from "@wfos/shared";
import { ACTIVE_RELEASE_STATUSES, FAILED_RELEASE_STATUSES } from "../deploy/preview";
import { appUrl, sha8 } from "../deploy/common";
import { afterTerminal, doneProgress, failTask } from "./task-status";
import { errorMessage } from "../lib/errors";
import { sql } from "drizzle-orm";
import { msg } from "@wfos/shared/messages";
import { workspaceLocale } from "../lib/settings";
import { appendToBranch, chatMessageDto } from "./chat-turns";
import { redactSecrets } from "@wfos/shared/server";
import { approvalTainted } from "./taint";
import { dataBlock, escapeData } from "./incidents";

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
    // on the branch of the reply that raised the approval (below the active leaf while that branch is shown)
    const m = await appendToBranch(
      {
        conversationId: a.conversationId,
        role: "system",
        content,
        employeeId: a.employeeId,
        handledAt: new Date(),
        // the title (and the tool output) come from a run that handled untrusted content: fenced and tainting later turns
        meta: { approvalId: a.id, ...((await approvalTainted(a)) ? { untrusted: true } : {}) },
      },
      a.messageId ?? null,
    );
    await publish(a.workspaceId, { type: "chat.message", conversationId: a.conversationId, message: chatMessageDto(m) });
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
      // the taint mark is read from the payload the run wrote, never from the human-edited copy; a skill also takes the
      // run's own taint (its guard steps / lineage), in case the payload flag is missing
      const untrusted = a.payload.untrustedInput === true || (a.toolName === "create_skill" && (await approvalTainted(a)));
      result = await executeAction(a.workspaceId, a.toolName, payload, { taskId: a.taskId, employeeId: a.employeeId, approvalId: a.id, untrusted, trigger: "approval" });
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
  if (a.taskId && a.toolName === "request_preview" && status === "EXECUTED") {
    // a release that already ended (a fast failure) found this approval still EXECUTING: hand it back now
    const [rel] = await db.select({ id: appReleases.id, status: appReleases.status }).from(appReleases).where(eq(appReleases.approvalId, a.id));
    if (rel && !isActive(rel)) await afterReleaseSettled(rel.id);
  }
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
    const [m] = await db.insert(memories).values({ workspaceId: a.workspaceId, employeeId: a.employeeId, kind: "feedback", source: "rejection", content, embedding }).returning();
    if (m) {
      await recordMemoryEvent({ workspaceId: a.workspaceId, employeeId: a.employeeId, memoryId: m.id, action: "create", actor: "rejection", before: null, after: memorySnapshot(m) }).catch((e) =>
        log.warn({ err: e }, "memory journal failed for rejection memory"),
      );
    }
    await recordStep({ workspaceId: a.workspaceId, taskId: a.taskId, conversationId: a.conversationId, employeeId: a.employeeId, kind: "system", name: "feedback_written_to_memory", output: content });
  }
  await postChatReceipt(a, { kind: "rejected" });
  if (a.taskId) await afterApprovalResolved(a.taskId);
}

type ReleaseRow = typeof appReleases.$inferSelect;

const consumed = (x: Pick<ApprovalRow, "executionResult">) => !!(x.executionResult as { consumed?: boolean } | null)?.consumed;
const simulatedResult = (x: Pick<ApprovalRow, "executionResult">) => !!(x.executionResult as { details?: { simulated?: boolean } } | null)?.details?.simulated;
const isActive = (r: Pick<ReleaseRow, "status">) => (ACTIVE_RELEASE_STATUSES as readonly string[]).includes(r.status);
const isFailed = (r: Pick<ReleaseRow, "status">) => (FAILED_RELEASE_STATUSES as readonly string[]).includes(r.status);

/** A preview release log's tail for the Developer: the last ~60 lines, at most 4 KB (the log is stored redacted). */
export function releaseLogTail(text: string, lines = 60, maxChars = 4096): string {
  let tail = text.trimEnd().split("\n").slice(-lines).join("\n");
  if (tail.length > maxChars) {
    tail = tail.slice(-maxChars);
    const nl = tail.indexOf("\n");
    if (nl >= 0 && nl < 400) tail = tail.slice(nl + 1);
  }
  return redactSecrets(tail);
}

function previewFailureNote(a: ApprovalRow, rel: ReleaseRow | null, attempt: number): string {
  const p = (a.payload ?? {}) as { appName?: string; commit?: string };
  const what = `The preview of ${escapeData(String(p.appName ?? "the app"))}${p.commit ? ` (commit ${sha8(String(p.commit))})` : ""}`;
  if (!rel) return `- ${what} did not run: its release no longer exists (the app may have been removed). Check list_apps before requesting a preview again.`;
  const status = rel.status === "rolled_back" ? "FAILED and was rolled back (the previous version runs again)" : "FAILED";
  // the error and the log are output of code the agent wrote: quoted as data, never as instructions
  return (
    `- ${what}, release ${rel.id}, ${status} at step ${rel.step ?? "prepare"}.\n` +
    `${dataBlock("release_error", receiptText(rel.error ?? "unknown error", 1000))}\n` +
    `Last lines of the release log:\n${dataBlock("release_log", releaseLogTail(rel.log))}\n` +
    `Fix it, commit, call git_push again (wait for the approval), then call request_preview again. ` +
    `Failed previews of this task so far: ${attempt} of ${PREVIEW_MAX_FAILED_ATTEMPTS}.`
  );
}

type Reader = Pick<typeof db, "select">;

/**
 * Executed git_push approvals whose repository builds an app the Developer may preview (request_preview granted):
 * the push alone does not finish such a task, it goes back to the Developer once to request the preview (or finish).
 */
async function pushesToPreview(tx: Reader, task: Pick<typeof tasks.$inferSelect, "assigneeId" | "workspaceId">, all: ApprovalRow[]): Promise<{ approval: ApprovalRow; apps: { id: string; name: string }[] }[]> {
  const pushes = all.filter((x) => x.toolName === "git_push" && x.status === "EXECUTED" && !consumed(x) && !simulatedResult(x));
  if (!pushes.length || !task.assigneeId) return [];
  const [emp] = await tx.select({ toolPermissions: employees.toolPermissions }).from(employees).where(eq(employees.id, task.assigneeId));
  if (!emp?.toolPermissions.some((p) => p.tool === "request_preview" && p.enabled)) return [];
  const out: { approval: ApprovalRow; apps: { id: string; name: string }[] }[] = [];
  for (const push of pushes) {
    const pp = (push.editedPayload ?? push.payload) as { repositoryId?: unknown; head?: unknown };
    if (typeof pp.repositoryId !== "string") continue;
    // already requested for this commit (the run went on after the push was approved): nothing to prompt
    if (all.some((x) => x.toolName === "request_preview" && (x.payload as { commit?: unknown }).commit === pp.head)) continue;
    const linked = await tx.select({ id: apps.id, name: apps.name }).from(apps).where(and(eq(apps.workspaceId, task.workspaceId), eq(apps.repositoryId, pp.repositoryId)));
    if (linked.length) out.push({ approval: push, apps: linked });
  }
  return out;
}

/** A FAILED request_preview the Developer already replaced with a later request (that one decides the outcome). */
function supersededPreview(x: ApprovalRow, all: ApprovalRow[]): boolean {
  return x.toolName === "request_preview" && x.status === "FAILED" && all.some((y) => y.id !== x.id && y.toolName === "request_preview" && y.createdAt > x.createdAt);
}

/**
 * When the last pending approval of a task is resolved: revise (if rejected with feedback) or close.
 * Idempotent: it only acts on an AWAITING_APPROVAL task (row-locked) with no open approval, and the
 * outcome moves the task out of AWAITING_APPROVAL in the same transaction (revise / DONE) or right
 * after it through failTask (conditional on AWAITING_APPROVAL). So calling it again, concurrently,
 * or from the reaper for a task whose resolver died, is harmless.
 *
 * Previews (Phase A3): while a release queued by an executed request_preview is queued or deploying, the task stays
 * AWAITING_APPROVAL (it waits on the platform); afterReleaseSettled calls this again once the release ended. A failed
 * or rolled-back preview, and a preview request that failed before anything was queued (a deploy already running,
 * the branch moved, the kill switch), go back to the Developer with what went wrong; together they count toward
 * PREVIEW_MAX_FAILED_ATTEMPTS, after which the task fails. The fail branch writes nothing in the transaction (no
 * approval is consumed), so a crash before failTask leaves the same decision for the next call.
 */
export async function afterApprovalResolved(taskId: string): Promise<void> {
  // Row lock so concurrent approval jobs cannot both resolve the same task.
  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!task || task.status !== "AWAITING_APPROVAL") return null;
    const all = await tx.select().from(approvals).where(eq(approvals.taskId, taskId));
    if (all.some((x) => x.status === "PENDING" || x.status === "APPROVED" || x.status === "EXECUTING")) return null;
    // handed back to the employee already, or a failed preview request replaced by a later one
    const settled = (x: ApprovalRow) => consumed(x) || supersededPreview(x, all);

    // previews whose result the task still has to take in (a simulated one queued nothing)
    const previews = all.filter((x) => x.toolName === "request_preview" && x.status === "EXECUTED" && !consumed(x) && !simulatedResult(x));
    const releases = previews.length ? await tx.select().from(appReleases).where(inArray(appReleases.approvalId, previews.map((x) => x.id))) : [];
    const waiting = releases.filter(isActive);
    if (waiting.length) return { kind: "wait" as const, task, releaseIds: waiting.map((r) => r.id) };
    const previewFailures = previews
      .map((approval) => ({ approval, release: releases.find((r) => r.approvalId === approval.id) ?? null }))
      .filter((f) => !f.release || isFailed(f.release));

    const needsRevision = all.filter((x) => x.status === "REJECTED" && x.feedback && !consumed(x));
    // Workspace mode: approved commands ran on the agent's behalf; it continues with their output
    const commandResults = all.filter((x) => x.toolName === "bash" && (x.status === "EXECUTED" || x.status === "FAILED") && !consumed(x));
    // a failed push, pull request or preview request (conflict, rejected, branch moved, a deploy already running) goes
    // back to the employee, not a silent failure
    const deliveryFailures = all.filter((x) => (x.toolName === "git_push" || x.toolName === "create_pull_request" || x.toolName === "request_preview") && x.status === "FAILED" && !settled(x));
    for (const r of deliveryFailures) commandResults.push(r);
    const requestFailures = deliveryFailures.filter((x) => x.toolName === "request_preview");
    // failed previews of this task: releases that failed or were rolled back, plus requests refused before queueing
    const failedAttempts =
      previewFailures.length || requestFailures.length
        ? (await tx.select({ status: appReleases.status }).from(appReleases).where(and(eq(appReleases.taskId, task.id), eq(appReleases.trigger, "approval")))).filter(isFailed).length +
          all.filter((x) => x.toolName === "request_preview" && x.status === "FAILED").length
        : 0;
    const previewNotes = previewFailures.map((f) => previewFailureNote(f.approval, f.release, failedAttempts));
    if ((previewFailures.length || requestFailures.length) && failedAttempts >= PREVIEW_MAX_FAILED_ATTEMPTS) {
      // the Developer had its tries: a person looks at it (failTask after commit, conditional on AWAITING_APPROVAL)
      const refusals = requestFailures.map((r) => `- A preview request failed before anything was deployed: ${receiptText(String((r.executionResult as { summary?: string } | null)?.summary ?? "unknown error"), 500)}`);
      const error = `The preview failed ${failedAttempts} times; the task stops here.\n${[...previewNotes, ...refusals].join("\n")}`.slice(0, 8000);
      return { kind: "fail" as const, task, result: task.result ?? "", error };
    }
    const toPreview = await pushesToPreview(tx, task, all);
    if (needsRevision.length || commandResults.length || previewFailures.length || toPreview.length) {
      for (const r of needsRevision) await tx.update(approvals).set({ executionResult: { consumed: true } }).where(eq(approvals.id, r.id));
      for (const r of [...commandResults, ...previewFailures.map((f) => f.approval), ...toPreview.map((t) => t.approval)]) {
        await tx.update(approvals).set({ executionResult: { ...(r.executionResult ?? {}), consumed: true } }).where(eq(approvals.id, r.id));
      }
      await tx.update(tasks).set({ status: "QUEUED" }).where(eq(tasks.id, task.id));
      const note = [
        ...needsRevision.map((r) => `- Your proposed "${r.title}" was REJECTED. Feedback: ${r.feedback}`),
        ...commandResults.map((r) => {
          if (r.toolName !== "bash") {
            const d = (r.executionResult as { summary?: string } | null) ?? {};
            if (r.toolName === "request_preview") {
              return (
                `- Publishing the preview FAILED before anything was deployed: ${d.summary ?? "unknown error"}. Fix the cause (push again with git_push if the branch moved), then call request_preview again. ` +
                `Failed previews of this task so far: ${failedAttempts} of ${PREVIEW_MAX_FAILED_ATTEMPTS}.`
              );
            }
            return `- ${r.toolName === "git_push" ? "Pushing your branch" : "Opening the pull request"} FAILED: ${d.summary ?? "unknown error"}. Fix the cause (for conflicts: rebase onto upstream/<default branch>, which is up to date), commit, and call ${r.toolName} again.`;
          }
          const d = (r.executionResult as { summary?: string; details?: { output?: string } } | null) ?? {};
          const out = String(d.details?.output ?? "").slice(-8000);
          return `- Approved command \`${String((r.editedPayload ?? r.payload).command ?? "")}\` ${d.summary ?? r.status}. Output:\n\`\`\`\n${out}\n\`\`\``;
        }),
        ...previewNotes,
        ...toPreview.map(({ approval, apps: linked }) => {
          const head = String((approval.editedPayload ?? approval.payload).head ?? "");
          const list = linked.map((x) => `"${escapeData(x.name)}" (appId ${x.id})`).join(", ");
          return (
            `- Your branch was pushed (commit ${sha8(head)}). This repository builds the app ${list}. ` +
            "If this task should update the app, call request_preview { appId, summary } now (list_apps shows the details), then end your run and wait for the result. " +
            "Otherwise finish with your summary. Do not say the app is updated: nothing is deployed until the platform reports the release as deployed."
          );
        }),
      ].join("\n");
      return { kind: "revise" as const, task, note };
    }
    const summary = all
      .map((x) => `- ${x.title}: ${x.status}${(x.executionResult as { summary?: string } | null)?.summary ? ` — ${(x.executionResult as { summary?: string }).summary}` : ""}`)
      .join("\n");
    const result = `${task.result ?? ""}\n\nApproval outcomes:\n${summary}`.trim();
    // a failure is written after commit by failTask (conditional on AWAITING_APPROVAL, so a concurrent resolver is a no-op);
    // a failure already handed back to the employee (consumed) was dealt with in a later run
    if (all.some((x) => x.status === "FAILED" && !settled(x))) return { kind: "fail" as const, task, result, error: "One or more approved actions failed to execute." };
    const [done] = await tx.update(tasks).set({ status: "DONE", result, completedAt: new Date(), error: null, progress: doneProgress() }).where(eq(tasks.id, task.id)).returning();
    return { kind: "close" as const, task: done! };
  });
  if (!outcome) return;
  const { task } = outcome;
  if (outcome.kind === "wait") {
    await recordPreviewWait(task, outcome.releaseIds);
    return;
  }
  if (outcome.kind === "revise") {
    await publish(task.workspaceId, { type: "task.updated", taskId: task.id, status: "QUEUED", employeeId: task.assigneeId, title: task.title });
    await enqueueTask(task.id, task.workspaceId, `${outcome.note}\nContinue the task: revise and propose again where appropriate.`);
    return;
  }
  if (outcome.kind === "fail") {
    await failTask(task, outcome.error, { kind: "approval_failed", result: outcome.result, onlyIfStatus: ["AWAITING_APPROVAL"] });
    return;
  }
  await afterTerminal(task, "DONE");
}

/** The task's last step says it waits for the preview (once per release: the reaper or a retry may ask again). */
async function recordPreviewWait(task: typeof tasks.$inferSelect, releaseIds: string[]): Promise<void> {
  for (const releaseId of releaseIds) {
    const [seen] = await db
      .select({ id: steps.id })
      .from(steps)
      .where(and(eq(steps.taskId, task.id), eq(steps.name, "waiting_for_preview"), sql`${steps.output} @> ${JSON.stringify({ releaseId })}::jsonb`))
      .limit(1);
    if (seen) continue;
    await recordStep({
      workspaceId: task.workspaceId,
      taskId: task.id,
      employeeId: task.assigneeId,
      kind: "system",
      name: "waiting_for_preview",
      status: "pending",
      output: { releaseId, note: "Waiting for the platform to build and deploy the approved preview" },
    }).catch((e: unknown) => log.warn({ err: e, taskId: task.id }, "preview wait step failed"));
  }
}

/**
 * A preview release this task asked for (request_preview) still has to come back: approved but not executed yet, its
 * release queued or deploying, or its outcome (a failure, a removed release) not taken in yet. A run that ends while
 * this holds does not finish the task: it waits (AWAITING_APPROVAL) and afterApprovalResolved decides.
 */
export async function previewOutstanding(taskId: string): Promise<boolean> {
  const [task] = await db.select({ assigneeId: tasks.assigneeId, workspaceId: tasks.workspaceId }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) return false;
  const all = await db.select().from(approvals).where(eq(approvals.taskId, taskId));
  const rows = all.filter((r) => r.toolName === "request_preview");
  if (rows.some((r) => r.status === "APPROVED" || r.status === "EXECUTING" || (r.status === "FAILED" && !consumed(r) && !supersededPreview(r, all)))) return true;
  const executed = rows.filter((r) => r.status === "EXECUTED" && !consumed(r) && !simulatedResult(r));
  if (executed.length) {
    const rels = await db.select({ approvalId: appReleases.approvalId, status: appReleases.status }).from(appReleases).where(inArray(appReleases.approvalId, executed.map((r) => r.id)));
    const open = executed.some((r) => {
      const rel = rels.find((x) => x.approvalId === r.id);
      return !rel || isActive(rel) || isFailed(rel);
    });
    if (open) return true;
  }
  // a push approved while the run went on, of a repository that builds an app: the Developer gets the offer to preview
  return (await pushesToPreview(db, task, all)).length > 0;
}

/**
 * A release ended (deployed, failed, rolled back, or settled after an interruption). When a task asked for it
 * (request_preview), the outcome goes on the approval (`executionResult.details.release`, once) and, when deployed,
 * a "Preview: <url>" deliverable on the task; then afterApprovalResolved finishes the task, or sends it back with the
 * log tail. A task that ended meanwhile (cancelled by a person, failed, done) is left alone. It may throw: the
 * pipeline calls it only after the release is stored, and logs the error.
 */
export async function afterReleaseSettled(releaseId: string): Promise<void> {
  const [rel] = await db.select().from(appReleases).where(eq(appReleases.id, releaseId));
  if (!rel?.taskId || isActive(rel)) return;
  const [task] = await db.select({ id: tasks.id, status: tasks.status, workspaceId: tasks.workspaceId }).from(tasks).where(eq(tasks.id, rel.taskId));
  if (!task || TERMINAL_STATUSES.includes(task.status)) return;
  const [app] = await db.select({ name: apps.name, domain: apps.domain }).from(apps).where(eq(apps.id, rel.appId));
  const url = app ? appUrl(app) : null;
  const deployed = rel.status === "deployed" || rel.status === "superseded";

  let first = false;
  if (rel.approvalId) {
    const [a] = await db.select().from(approvals).where(eq(approvals.id, rel.approvalId));
    const er = (a?.executionResult ?? {}) as { summary?: string; details?: Record<string, unknown> };
    if (a && a.status === "EXECUTED" && !er.details?.release) {
      const base = er.summary ?? `Preview queued: release ${rel.id}`;
      const next = {
        ...er,
        summary: deployed && url ? `${base} — deployed at ${url}` : `${base} — ${rel.status === "rolled_back" ? "rolled back" : "failed"} at ${rel.step ?? "prepare"}`,
        details: { ...(er.details ?? {}), release: { id: rel.id, status: rel.status, url, ...(deployed ? {} : { step: rel.step, error: rel.error }) } },
      };
      // written once: a second call (retry, recovery) finds details.release and adds nothing
      const updated = await db
        .update(approvals)
        .set({ executionResult: next })
        // only once executeApproval stored its own result (EXECUTED): that write never replaces this one; while it is
        // still EXECUTING, executeApproval hands the settled release back itself right after
        .where(and(eq(approvals.id, a.id), eq(approvals.status, "EXECUTED"), sql`(${approvals.executionResult} -> 'details' -> 'release') is null`))
        .returning({ id: approvals.id });
      first = updated.length > 0;
      if (first) await publish(task.workspaceId, { type: "approval.updated", approvalId: a.id, status: a.status });
    }
  }
  if (deployed && first && url && app) {
    const d: Deliverable = {
      id: crypto.randomUUID(),
      kind: "summary",
      title: `Preview: ${url}`,
      content: `${app.name} runs commit ${rel.commit}${rel.commitSubject ? ` "${rel.commitSubject}"` : ""} at ${url} (release ${rel.id}).`,
      meta: { appId: rel.appId, releaseId: rel.id, url, commit: rel.commit, approvalId: rel.approvalId },
      createdAt: new Date().toISOString(),
    };
    await db.update(tasks).set({ deliverables: sql`${tasks.deliverables} || ${JSON.stringify([d])}::jsonb` }).where(eq(tasks.id, task.id));
    await recordStep({ workspaceId: task.workspaceId, taskId: task.id, kind: "system", name: "preview_deployed", output: { releaseId: rel.id, url, commit: rel.commit } }).catch(() => {});
  }
  await afterApprovalResolved(rel.taskId);
}

/** A settled release is handed back by the reaper when it ended at least this long ago and its approval still lacks it. */
export const RELEASE_HANDBACK_AFTER_MS = 2 * 60_000;

/**
 * Reaper: settled preview releases whose hand-back never happened (handBack threw, the worker died right after the
 * release was stored): their task still waits, so the outcome (details.release, the deliverable) is handed back now.
 */
export async function handBackMissedReleases(now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: appReleases.id })
    .from(appReleases)
    .innerJoin(approvals, eq(approvals.id, appReleases.approvalId))
    .innerJoin(tasks, eq(tasks.id, appReleases.taskId))
    .where(
      and(
        inArray(appReleases.status, ["deployed", "superseded", ...FAILED_RELEASE_STATUSES]),
        sql`${appReleases.finishedAt} < ${new Date(now.getTime() - RELEASE_HANDBACK_AFTER_MS).toISOString()}::timestamptz`,
        eq(approvals.status, "EXECUTED"),
        sql`(${approvals.executionResult} -> 'details' -> 'release') is null`,
        sql`not coalesce((${approvals.executionResult} ->> 'consumed')::boolean, false)`,
        inArray(tasks.status, ["QUEUED", "RUNNING", "AWAITING_APPROVAL"]),
      ),
    )
    .limit(50);
  const done: string[] = [];
  for (const r of rows) {
    try {
      await afterReleaseSettled(r.id);
      done.push(r.id);
    } catch (e) {
      log.warn({ err: e, releaseId: r.id }, "reaper: handing a settled release back failed");
    }
  }
  return done;
}
