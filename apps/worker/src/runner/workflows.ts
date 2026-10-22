import { and, eq, inArray, lte } from "drizzle-orm";
import { approvals, createTask, db, nextCronRun, tasks, workflowRuns, workflows } from "@wfos/db";
import { TERMINAL_STATUSES, WORKFLOW_APPROVAL_TOOL, type WorkflowStep } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { enqueueTask, miscQueue, publish } from "../lib/redis";
import { log } from "../lib/logger";
import { workspaceLocale } from "../lib/settings";
import { dataBlock } from "./incidents";

/**
 * Workflows (after OpenHuman's workflows): a run walks the steps it was started with, one after the other, and waits
 * durably where a step waits on someone:
 * - agent: a task for the employee (the previous output follows the instruction as data); the run goes on when the
 *   task is DONE and fails when the task fails or is cancelled;
 * - condition: the previous output must (not) contain a text, else the run stops;
 * - approval: a person approves (workflow_step); a rejection, or no answer within the workspace's expiry, stops it;
 * - notify: a notice with the previous output.
 * advanceWorkflowRun is idempotent and takes the run's row lock, so a task end, an approval and the reaper can all
 * call it.
 */

type Run = typeof workflowRuns.$inferSelect;
type Workflow = typeof workflows.$inferSelect;

/** what one step hands on, kept per run (an agent's result can be long) */
const OUTPUT_CHARS = 20_000;
const NOTIFY_OUTPUT_CHARS = 1500;
const OPEN: Run["status"][] = ["running", "waiting"];

export const workflowAdvanceJob = (workspaceId: string, runId: string) =>
  miscQueue.add("workflow_advance", { kind: "workflow_advance", workspaceId, runId }, { jobId: `wf-advance-${runId}-${Date.now()}` });

/** Start a run with the workflow's current steps. Refused (null) while another run of it is still open. */
export async function startWorkflowRun(workflowId: string, trigger: "manual" | "schedule", userId?: string | null): Promise<Run | null> {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  if (!wf) return null;
  const run = await db.transaction(async (tx) => {
    // the workflow's row lock serializes starts: two clicks (or a click and the schedule) cannot both open a run
    await tx.select({ id: workflows.id }).from(workflows).where(eq(workflows.id, wf.id)).for("update");
    const [open] = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, wf.id), inArray(workflowRuns.status, OPEN)))
      .limit(1);
    if (open) return null;
    const [r] = await tx
      .insert(workflowRuns)
      .values({ workflowId: wf.id, workspaceId: wf.workspaceId, trigger, startedBy: userId ?? null, steps: wf.steps, untrusted: wf.untrustedInput })
      .returning();
    await tx.update(workflows).set({ lastRunAt: new Date() }).where(eq(workflows.id, wf.id));
    return r!;
  });
  if (!run) return null;
  await advanceWorkflowRun(run.id);
  return run;
}

function agentBrief(step: Extract<WorkflowStep, { kind: "agent" }>, wf: Workflow, index: number, prev: string): string {
  const head = `${step.instruction}\n\n(Step ${index + 1} of the workflow "${wf.name}".)`;
  return prev ? `${head}\n\nThe previous step's output:\n${dataBlock("previous_step_output", prev)}` : head;
}

type Effect = { enqueueTaskId?: string; approvalId?: string; notify?: { title: string; text: string }; ended?: Run["status"] };

/** Move a run on as far as it can go now. */
export async function advanceWorkflowRun(runId: string): Promise<void> {
  const effects: Effect = {};
  let wf: Workflow | undefined;
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    if (!run || !OPEN.includes(run.status)) return;
    [wf] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId));
    if (!wf) return;
    let { stepIndex, untrusted } = run;
    const outputs = [...run.outputs];
    let waitingTaskId = run.waitingTaskId;
    let waitingApprovalId = run.waitingApprovalId;
    let status: Run["status"] = "running";
    let error: string | null = null;

    while (status === "running" && stepIndex < run.steps.length) {
      const step = run.steps[stepIndex]!;
      const prev = outputs.at(-1) ?? "";
      if (step.kind === "agent") {
        if (waitingTaskId) {
          const [t] = await tx.select().from(tasks).where(eq(tasks.id, waitingTaskId));
          if (t && !(TERMINAL_STATUSES as readonly string[]).includes(t.status)) {
            status = "waiting";
            break;
          }
          if (!t || t.status !== "DONE") {
            status = "failed";
            error = `Step ${stepIndex + 1}: the task ended ${(t?.status ?? "deleted").toLowerCase()}${t?.error ? ` (${t.error.slice(0, 300)})` : ""}.`;
            break;
          }
          untrusted ||= t.untrustedInput;
          outputs.push((t.result ?? "").slice(0, OUTPUT_CHARS));
          waitingTaskId = null;
          stepIndex++;
          continue;
        }
        const task = await createTask(tx, {
          workspaceId: wf.workspaceId,
          title: `${wf.name} · ${stepIndex + 1}`.slice(0, 200),
          brief: agentBrief(step, wf, stepIndex, prev),
          assigneeId: step.employeeId,
          source: "workflow",
          untrustedInput: untrusted,
        });
        await tx.update(tasks).set({ workflowRunId: run.id }).where(eq(tasks.id, task.id));
        waitingTaskId = task.id;
        effects.enqueueTaskId = task.id;
        status = "waiting";
        break;
      }
      if (step.kind === "condition") {
        const hit = prev.toLowerCase().includes(step.text.toLowerCase());
        if (hit !== (step.mode === "contains")) {
          status = "stopped";
          error = `Step ${stepIndex + 1}: the previous output ${step.mode === "contains" ? "does not contain" : "contains"} "${step.text}".`;
          break;
        }
        outputs.push(prev);
        stepIndex++;
        continue;
      }
      if (step.kind === "approval") {
        if (waitingApprovalId) {
          const [a] = await tx.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, waitingApprovalId));
          if (a?.status === "EXECUTED") {
            outputs.push(prev);
            waitingApprovalId = null;
            stepIndex++;
            continue;
          }
          if (a && (a.status === "PENDING" || a.status === "APPROVED" || a.status === "EXECUTING")) {
            status = "waiting";
            break;
          }
          status = "stopped";
          error = `Step ${stepIndex + 1}: "${step.title}" was ${(a?.status ?? "removed").toLowerCase()}.`;
          break;
        }
        const [a] = await tx
          .insert(approvals)
          .values({
            workspaceId: wf.workspaceId,
            toolName: WORKFLOW_APPROVAL_TOOL,
            title: `${wf.name}: ${step.title}`.slice(0, 300),
            reason: `Workflow step ${stepIndex + 1} waits for a person.`,
            payload: { workflowId: wf.id, workflowName: wf.name, runId: run.id, step: stepIndex + 1, title: step.title, previousOutput: prev.slice(0, 4000), untrustedInput: untrusted },
          })
          .returning({ id: approvals.id });
        waitingApprovalId = a!.id;
        effects.approvalId = a!.id;
        status = "waiting";
        break;
      }
      // notify
      effects.notify = { title: `${wf.name}: ${step.title}`, text: prev.slice(0, NOTIFY_OUTPUT_CHARS) };
      outputs.push(prev);
      stepIndex++;
    }
    if (status === "running") status = "done";
    const ended = status === "done" || status === "stopped" || status === "failed";
    if (ended) effects.ended = status;
    await tx
      .update(workflowRuns)
      .set({ stepIndex, outputs, untrusted, waitingTaskId, waitingApprovalId, status, error, ...(ended ? { finishedAt: new Date() } : {}) })
      .where(eq(workflowRuns.id, run.id));
  });
  if (!wf) return;
  const w: Workflow = wf;
  if (effects.enqueueTaskId) {
    await publish(w.workspaceId, { type: "task.created", taskId: effects.enqueueTaskId, title: w.name, employeeId: null });
    await enqueueTask(effects.enqueueTaskId, w.workspaceId);
  }
  const locale = effects.approvalId || effects.ended === "failed" ? await workspaceLocale(w.workspaceId) : null;
  if (effects.approvalId) {
    await publish(w.workspaceId, { type: "approval.created", approvalId: effects.approvalId, taskId: null, conversationId: null, title: w.name });
    await miscQueue.add("notify", {
      kind: "notify",
      notificationKind: "approval",
      workspaceId: w.workspaceId,
      subject: msg(locale, "notify.workflowApproval", { workflow: w.name }),
      text: msg(locale, "notify.workflowApprovalText", { workflow: w.name }),
      link: `/approvals?focus=${effects.approvalId}`,
      approvalId: effects.approvalId,
    });
  }
  if (effects.notify) {
    await miscQueue.add("notify", { kind: "notify", workspaceId: w.workspaceId, subject: effects.notify.title, text: effects.notify.text || effects.notify.title, link: `/workflows?id=${w.id}` });
  }
  if (effects.ended === "failed") {
    await miscQueue.add("notify", {
      kind: "notify",
      notificationKind: "routine_failed",
      workspaceId: w.workspaceId,
      subject: msg(locale, "notify.workflowFailed", { workflow: w.name }),
      text: msg(locale, "notify.workflowFailedText", { workflow: w.name }),
      link: `/workflows?id=${w.id}`,
    });
  }
}

/** After a task ended: the workflow run it belongs to goes on. */
export async function onWorkflowTaskEnded(task: { workspaceId: string; workflowRunId: string | null }): Promise<void> {
  if (task.workflowRunId) await workflowAdvanceJob(task.workspaceId, task.workflowRunId);
}

/** After a workflow_step approval was executed, rejected or expired: its run goes on (or stops). */
export async function onWorkflowApprovalSettled(a: { toolName: string; workspaceId: string; payload: Record<string, unknown> }): Promise<void> {
  if (a.toolName !== WORKFLOW_APPROVAL_TOOL || typeof a.payload.runId !== "string") return;
  await workflowAdvanceJob(a.workspaceId, a.payload.runId);
}

/**
 * Every 30 s: enabled scheduled workflows that are due start a run (claimed by moving next_run_at, safe with several
 * workers). A due workflow whose previous run is still open skips this firing. Enabled ones without a next run get one.
 */
export async function tickWorkflows(now = new Date()): Promise<void> {
  const enabled = await db.select().from(workflows).where(eq(workflows.enabled, true));
  for (const wf of enabled) {
    if (wf.trigger.kind !== "schedule") continue;
    let next: Date;
    try {
      next = nextCronRun(wf.trigger.cron, wf.trigger.timezone, now);
    } catch (e) {
      log.error({ err: e, workflowId: wf.id }, "invalid cron; turning the workflow off");
      await db.update(workflows).set({ enabled: false, nextRunAt: null }).where(eq(workflows.id, wf.id));
      continue;
    }
    if (!wf.nextRunAt) {
      await db.update(workflows).set({ nextRunAt: next }).where(eq(workflows.id, wf.id));
      continue;
    }
    if (wf.nextRunAt > now) continue;
    const claimed = await db
      .update(workflows)
      .set({ nextRunAt: next })
      .where(and(eq(workflows.id, wf.id), lte(workflows.nextRunAt, now)))
      .returning({ id: workflows.id });
    if (!claimed.length) continue;
    try {
      const run = await startWorkflowRun(wf.id, "schedule");
      if (!run) log.info({ workflowId: wf.id }, "workflow firing skipped: the previous run is still open");
    } catch (e) {
      log.error({ err: e, workflowId: wf.id }, "workflow run failed to start");
    }
  }
}

/** Reaper: waiting runs whose task or approval already settled (a lost advance job) are moved on. */
export async function advanceStuckWorkflowRuns(): Promise<string[]> {
  const rows = await db
    .select({ id: workflowRuns.id, taskStatus: tasks.status, approvalStatus: approvals.status })
    .from(workflowRuns)
    .leftJoin(tasks, eq(tasks.id, workflowRuns.waitingTaskId))
    .leftJoin(approvals, eq(approvals.id, workflowRuns.waitingApprovalId))
    .where(eq(workflowRuns.status, "waiting"))
    .limit(200);
  const settledApproval = (s: string | null) => !!s && s !== "PENDING" && s !== "APPROVED" && s !== "EXECUTING";
  const stuck = rows.filter((r) => (r.taskStatus && (TERMINAL_STATUSES as readonly string[]).includes(r.taskStatus)) || settledApproval(r.approvalStatus));
  for (const r of stuck) await advanceWorkflowRun(r.id);
  return stuck.map((r) => r.id);
}
