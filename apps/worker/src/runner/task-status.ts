import { and, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { settleAppTest } from "../qa/app-test";
import { settleHrReview } from "../hr/review";
import { advanceAppTestSuite, apps, audit, db, moduleAppOfTask, takeQueuedModuleWork, tasks, type SuiteEnd } from "@wfos/db";
import { assertTransition, TASK_STATUSES, canTransition, type RoutineRunStatus, type RunJob, type TaskStatus } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { enqueueTask, miscQueue, publish } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { workspaceLocale } from "../lib/settings";
import { log } from "../lib/logger";
import { isTaskRunActive } from "../guards/killswitch";
import { onChildFinished } from "../orchestration/team";
import { DEPENDENCY_PHASES } from "../orchestration/phases";
import { closeTurnOfMessage } from "./chat-turns";
import { incidentKindOf, openIncident, openRoutineIncident, resolveIncidentsOnTerminal, type FailureKind } from "./incidents";

type Task = typeof tasks.$inferSelect;
type TerminalStatus = "DONE" | "FAILED" | "CANCELLED";

/** Statuses a task can fail from (QUEUED, RUNNING, AWAITING_APPROVAL). */
const FAILABLE: TaskStatus[] = TASK_STATUSES.filter((s) => s !== "FAILED" && canTransition(s, "FAILED"));

/** Side effects after a status change must not stop the others (a Redis hiccup must not strand the parent). */
async function bestEffort(label: string, taskId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error({ err: e, taskId }, `${label} failed`);
  }
}

/**
 * Side effects of a task reaching a terminal status, in this order: wake the parent (team lead) when
 * all its subtasks have ended, settle the routine run (a failed run opens its routine incident), close the
 * incidents this end resolves, publish task.updated, notify humans (DONE of top-level, non-replay tasks;
 * a cancellation is a human's own action and is not notified). A FAILED task is notified by its incident
 * (see ./incidents), so FAILED only notifies here when `notifyFailure` is set (opening the incident failed).
 * Each step is best-effort: one failing (Redis down, a query error) never skips the others.
 * `task` is the row as written (status already terminal).
 */
export async function afterTerminal(task: Task, status: TerminalStatus, opts: { notifyFailure?: boolean } = {}): Promise<void> {
  await bestEffort("cancel waiting subtasks", task.id, () => cancelWaitingSubtasks(task, status));
  if (task.parentTaskId) await bestEffort("wake parent", task.id, () => onChildFinished(task.workspaceId, task.parentTaskId!));
  await bestEffort("routine run settle", task.id, () => settleRoutineRun(task));
  await bestEffort("incidents resolve", task.id, () => resolveIncidentsOnTerminal(task, status));
  // C3: an app test whose task ended without a report is an error (never left running)
  await bestEffort("app test settle", task.id, () => settleAppTest(task.id, status));
  // a package of a full app test: the next package starts; the suite notifies once, at its end
  let inSuite = false;
  await bestEffort("app test suite", task.id, async () => {
    inSuite = await advanceTestSuite(task.id);
  });
  await bestEffort("hr review settle", task.id, () => settleHrReview(task.id));
  // C8: one module build or change runs per app; the end of one starts the next that waits
  await bestEffort("module queue", task.id, () => startWaitingModuleWork(task.id));
  await bestEffort("publish", task.id, () => publish(task.workspaceId, { type: "task.updated", taskId: task.id, status, employeeId: task.assigneeId, title: task.title }));
  if (status === "DONE" && !inSuite) await bestEffort("notify", task.id, () => notifyFinished(task, status, task.result ?? ""));
  if (status === "FAILED" && opts.notifyFailure) await bestEffort("notify", task.id, () => notifyFinished(task, status, task.error ?? ""));
}

/** After a task ended: the next package of its full app test starts, or the suite ends with one summary. True: in a suite. */
export async function advanceTestSuite(taskId: string): Promise<boolean> {
  const r = await advanceAppTestSuite(db, taskId, async (appId) => (await db.select({ id: apps.id, name: apps.name, clientId: apps.clientId, projectId: apps.projectId }).from(apps).where(eq(apps.id, appId)))[0] ?? null);
  if (r.task) {
    await publish(r.task.workspaceId, { type: "task.created", taskId: r.task.id, title: r.task.title, employeeId: r.task.assigneeId });
    await enqueueTask(r.task.id, r.task.workspaceId);
  }
  if (r.ended) await notifySuiteEnded(r.ended);
  return r.inSuite;
}

async function notifySuiteEnded(e: SuiteEnd): Promise<void> {
  const locale = await workspaceLocale(e.workspaceId);
  const total = e.findings.high + e.findings.medium + e.findings.low;
  await miscQueue.add("notify", {
    kind: "notify",
    notificationKind: "task_done",
    employeeId: null,
    workspaceId: e.workspaceId,
    subject: msg(locale, "notify.testSuiteEnded", { app: e.appName, findings: total }),
    text: msg(locale, "notify.testSuiteEndedText", { packages: e.packages, high: e.findings.high, medium: e.findings.medium, low: e.findings.low, failed: e.failed }),
    link: `/apps/${e.appId}?tab=tests`,
  });
}

/** After a task linked to an app module ended: start the oldest waiting build or change of that app, if any. */
export async function startWaitingModuleWork(taskId: string): Promise<void> {
  const at = await moduleAppOfTask(taskId);
  if (!at) return;
  const { task, dropped } = await takeQueuedModuleWork(db, at.workspaceId, at.appId);
  if (dropped) {
    log.warn({ appId: at.appId, moduleId: dropped.moduleId, err: dropped.error }, "waiting module work could not start");
    await audit({ workspaceId: at.workspaceId, actorLabel: "system", action: "app.module_work_dropped", targetType: "app", targetId: at.appId, details: { moduleId: dropped.moduleId, error: dropped.error.slice(0, 300) } });
  }
  if (!task) return;
  await publish(task.workspaceId, { type: "task.created", taskId: task.id, title: task.title, employeeId: task.assigneeId });
  await enqueueTask(task.id, task.workspaceId);
}

/**
 * A parent that ended (DONE / FAILED / CANCELLED) takes its ordered subtasks that never got to start with it: those
 * still waiting for (phase after) or blocked by (phase blocked) their dependencies are CANCELLED with the reason.
 */
async function cancelWaitingSubtasks(parent: Pick<Task, "id" | "workspaceId">, status: TerminalStatus): Promise<void> {
  const rows = await db
    .update(tasks)
    .set({ status: "CANCELLED", completedAt: new Date(), error: `Cancelled: the parent task ended (${status}) before the subtasks this one waits for were done.` })
    .where(and(eq(tasks.parentTaskId, parent.id), eq(tasks.status, "QUEUED"), inArray(tasks.phase, DEPENDENCY_PHASES)))
    .returning();
  for (const r of rows) {
    log.info({ taskId: r.id, parentTaskId: parent.id }, "waiting subtask cancelled with its parent");
    await afterTerminal(r, "CANCELLED");
  }
}

/**
 * Every non-failure status change. FAILED goes through failTask, which owns the failure side effects.
 * Conditional: the row only changes while its status is still `task.status` (the status the caller
 * believes it has), so a task cancelled from the web or finished by another path in the meantime is
 * left alone. Returns false (and runs no side effects) when the row no longer matched.
 * Terminal statuses run afterTerminal.
 */
/** progress of a task that becomes DONE: 100 when the assignee reported any, else left empty */
export function doneProgress() {
  return sql<number | null>`case when ${tasks.progress} is null then null else 100 end`;
}

export async function setTaskStatus(
  task: Pick<Task, "id" | "status">,
  to: Exclude<TaskStatus, "FAILED">,
  extra: Partial<Task> = {},
): Promise<boolean> {
  assertTransition(task.status, to);
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({
      status: to,
      ...(to === "RUNNING" ? { startedAt: now } : {}),
      ...(to === "DONE" || to === "CANCELLED" ? { completedAt: now } : {}),
      // a finished task is 100 % done, whatever the assignee last reported (never reported stays empty)
      ...(to === "DONE" ? { progress: doneProgress() } : {}),
      ...extra,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
    .returning();
  if (!row) {
    log.debug({ taskId: task.id, expected: task.status, to }, "task status changed meanwhile; transition skipped");
    return false;
  }
  if (to === "DONE" || to === "CANCELLED") await afterTerminal(row, to);
  else await bestEffort("publish", row.id, () => publish(row.workspaceId, { type: "task.updated", taskId: row.id, status: to, employeeId: row.assigneeId, title: row.title }));
  return true;
}

/** stalled / loop: the run was stopped by the executor (AgentRunOutput.stopped); each maps to an incident kind. */
export type FailKind = FailureKind;

export interface FailOptions {
  kind?: FailKind;
  /** also record an error step (`stepName`, default task_failed) carrying the message */
  step?: boolean;
  stepName?: string;
  /** employee attributed on the step */
  employeeId?: string | null;
  /** overwrite tasks.result (e.g. partial output of the failed run) */
  result?: string | null;
  /** only fail from these statuses (default: any status that may transition to FAILED) */
  onlyIfStatus?: TaskStatus[];
  /** only fail if the row was not touched since (race guard for the reaper) */
  staleBefore?: Date;
}

/**
 * The one way a task becomes FAILED. A single conditional UPDATE decides; when the task is already
 * terminal (or no longer matches `onlyIfStatus` / `staleBefore`) nothing happens and it returns false,
 * so calling it twice, or racing another finisher, is harmless.
 * On a real transition: the failure step (opts.step), the incident (./incidents: handled by the team lead,
 * escalated to a person, or muted; this is also the human notification), then afterTerminal (wake the
 * parent, settle the routine run, publish task.updated).
 */
export async function failTask(task: Pick<Task, "id">, error: string, opts: FailOptions = {}): Promise<boolean> {
  const kind = opts.kind ?? "error";
  const from = opts.onlyIfStatus ? opts.onlyIfStatus.filter((s) => FAILABLE.includes(s)) : FAILABLE;
  if (!from.length) return false;
  const conds: SQL[] = [eq(tasks.id, task.id), inArray(tasks.status, from)];
  if (opts.staleBefore) conds.push(lt(tasks.updatedAt, opts.staleBefore));
  const [row] = await db
    .update(tasks)
    .set({ status: "FAILED", error, completedAt: new Date(), ...(opts.result !== undefined ? { result: opts.result } : {}) })
    .where(and(...conds))
    .returning();
  if (!row) return false;
  log.info({ taskId: row.id, kind, error }, "task failed");

  if (opts.step) {
    await bestEffort("failure step", row.id, () =>
      recordStep({ workspaceId: row.workspaceId, taskId: row.id, employeeId: opts.employeeId ?? null, kind: "error", name: opts.stepName ?? "task_failed", status: "error", output: { kind, error } }),
    );
  }
  const incidentOpened = await openIncident(row, incidentKindOf(kind), error).then(
    () => true,
    (e: unknown) => (log.error({ err: e, taskId: row.id }, "open incident failed"), false),
  );
  // the incident must exist before the parent is woken: the lead's review prompt shows it
  await afterTerminal(row, "FAILED", { notifyFailure: !incidentOpened });
  return true;
}

export async function notifyFinished(
  task: Pick<Task, "workspaceId" | "id" | "title" | "parentTaskId" | "source"> & Partial<Pick<Task, "assigneeId" | "deliverables">>,
  status: TaskStatus,
  text: string,
): Promise<void> {
  if (task.parentTaskId || task.source === "replay") return; // only top-level tasks notify humans
  // a finished task with nothing to show (no result text, no deliverable) is not worth interrupting anyone for
  if (status === "DONE" && !text.trim() && !task.deliverables?.length) return;
  const locale = await workspaceLocale(task.workspaceId);
  await miscQueue.add("notify", {
    kind: "notify",
    notificationKind: status === "DONE" ? "task_done" : "task_failed",
    employeeId: task.assigneeId ?? null,
    workspaceId: task.workspaceId,
    subject: msg(locale, status === "DONE" ? "notify.taskFinished" : "notify.taskFailed", { title: task.title }),
    text: text.slice(0, 1500),
    link: `/tasks/${task.id}`,
  });
}

// ---------------------------------------------------------------------------
// Routine runs: "dispatched" until every task of the firing has ended, then "done" / "failed".
// ---------------------------------------------------------------------------

/**
 * One conditional UPDATE: settles the dispatched routine runs matching `filter` whose tasks are all
 * terminal. Idempotent (only rows still "dispatched" change; Postgres re-checks that on the locked
 * row) and race-safe: every finisher calls it after its own status write committed, so the last task
 * to end always sees all the others ended. A task id that no longer exists counts as not DONE.
 */
async function settleRuns(filter: SQL): Promise<{ id: string; status: RoutineRunStatus }[]> {
  const rows = await db.execute<{ id: string; status: RoutineRunStatus; routine_id: string; error: string | null; first_failed: string | null }>(sql`
    UPDATE routine_runs rr
    SET status = CASE WHEN s.not_done = 0 THEN 'done' ELSE 'failed' END,
        error = CASE WHEN s.not_done = 0 THEN NULL ELSE s.first_error END
    FROM (
      SELECT r.id,
        count(*) FILTER (WHERE t.status IN ('QUEUED', 'RUNNING', 'AWAITING_APPROVAL')) AS open,
        count(*) FILTER (WHERE t.id IS NULL OR t.status <> 'DONE') AS not_done,
        (array_agg(
          CASE WHEN t.id IS NULL THEN 'Task ' || e.tid || ' was deleted.'
               ELSE coalesce(nullif(t.error, ''), 'Task "' || t.title || '" ended ' || t.status) END
          ORDER BY e.ord) FILTER (WHERE t.id IS NULL OR t.status <> 'DONE'))[1] AS first_error,
        (array_agg(e.tid ORDER BY e.ord) FILTER (WHERE t.id IS NULL OR t.status <> 'DONE'))[1] AS first_failed
      FROM routine_runs r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.task_ids) WITH ORDINALITY AS e(tid, ord)
      LEFT JOIN tasks t ON t.id = e.tid::uuid
      WHERE r.status = 'dispatched' AND ${filter}
      GROUP BY r.id
    ) s
    WHERE rr.id = s.id AND rr.status = 'dispatched' AND s.open = 0
    RETURNING rr.id, rr.status, rr.routine_id, rr.error, s.first_failed`);
  // the UPDATE returns a run once (only "dispatched" rows change): one routine_failed incident per failed run
  for (const r of rows) {
    if (r.status !== "failed") continue;
    await bestEffort("routine incident", r.first_failed ?? r.id, () =>
      openRoutineIncident({ routineId: r.routine_id, firstFailedTaskId: r.first_failed, error: r.error }),
    );
  }
  return [...rows].map((r) => ({ id: r.id, status: r.status }));
}

/**
 * Settle the routine run this task belongs to, once all of that run's tasks have ended. The query
 * always filters by routine_id (indexed path, never a scan of every run): a caller that passes a
 * partial task without routineId gets it looked up.
 */
export async function settleRoutineRun(task: Pick<Task, "id"> & Partial<Pick<Task, "routineId">>): Promise<{ id: string; status: RoutineRunStatus }[]> {
  let routineId = task.routineId;
  if (routineId === undefined) {
    const [t] = await db.select({ routineId: tasks.routineId }).from(tasks).where(eq(tasks.id, task.id));
    routineId = t?.routineId ?? null;
  }
  if (!routineId) return []; // not from a routine (or gone)
  return settleRuns(sql`r.routine_id = ${routineId} AND r.task_ids @> jsonb_build_array(${task.id}::text)`);
}

/**
 * Sweep: settle every dispatched run whose tasks all ended through a path that does not settle
 * (cancelled from the API, deleted, or finished before dispatchRoutine inserted the run row).
 * A firing that created no tasks (per-client routine, no clients) is done.
 */
export async function settleDispatchedRoutineRuns(): Promise<number> {
  const settled = await settleRuns(sql`true`);
  const empty = await db.execute<{ id: string }>(
    sql`UPDATE routine_runs SET status = 'done' WHERE status = 'dispatched' AND jsonb_array_length(task_ids) = 0 RETURNING id`,
  );
  return settled.length + [...empty].length;
}

// ---------------------------------------------------------------------------
// BullMQ: a run job that failed for good (retries exhausted, or stalled) must not leave its task RUNNING.
// ---------------------------------------------------------------------------

export interface FailedRunJob {
  data: RunJob;
  attemptsMade: number;
  opts: { attempts?: number };
  failedReason?: string;
}

/**
 * Logic of the runs worker's `failed` handler. Returns true when it failed the task, or (chat job)
 * closed the turn's streaming reply as an error.
 */
export async function handleRunJobFailed(job: FailedRunJob): Promise<boolean> {
  // a stalled job (maxStalledCount 0) goes straight to failed whatever its attempt count
  const final = job.attemptsMade >= (job.opts.attempts ?? 1) || /stalled/i.test(job.failedReason ?? "");
  if (!final) return false; // the retry runs (or skips) the task; a stranded RUNNING task is left to the reaper
  if (job.data.kind !== "task") {
    // the turn that claimed this message must not stay 'streaming' forever (the reaper is the backstop)
    const messageId = job.data.kind === "chat" ? job.data.messageId : job.data.userMessageId;
    const closed = await closeTurnOfMessage(messageId);
    if (closed.length) log.warn({ messageId, closed: closed.map((m) => m.id) }, "chat turn of a failed job closed as error");
    return closed.length > 0;
  }
  const [t] = await db.select({ id: tasks.id, status: tasks.status, phase: tasks.phase }).from(tasks).where(eq(tasks.id, job.data.taskId));
  if (!t || t.status !== "RUNNING") return false;
  if (t.phase === "wait" || t.phase === "hold") return false; // a lead waiting on subtasks has no run of its own
  if (isTaskRunActive(t.id)) return false; // another job of this task is running here
  return failTask(t, `Worker error: ${job.failedReason ?? "job failed"}`, { kind: "error", onlyIfStatus: ["RUNNING"], step: true, stepName: "worker_error" });
}
