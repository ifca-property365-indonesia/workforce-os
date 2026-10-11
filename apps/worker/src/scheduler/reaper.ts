import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, tasks, teams } from "@wfos/db";
import { runsQueue } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { log } from "../lib/logger";
import { activeConversationIds, isTaskRunActive } from "../guards/killswitch";
import { tasksHoldingLease } from "../guards/lease";
import { failTask, settleDispatchedRoutineRuns } from "../runner/task-status";
import { afterApprovalResolved } from "../runner/approvals";
import { onChildFinished } from "../orchestration/team";
import { CHAT_TURN_STALE_MS, closeStaleTurns } from "../runner/chat-turns";

/**
 * Stale RUNNING reaper.
 *
 * A task can be left RUNNING with nothing working on it: the worker crashed or restarted mid-run,
 * or runTask threw after setting RUNNING (the BullMQ retry then sees RUNNING and skips it).
 *
 * A RUNNING task is an orphan when
 * - its phase is not wait/hold (a team lead waiting on subtasks has no run of its own; RUNNING +
 *   review IS a run — the lead's review — so it is reaped like any other once it is unattended),
 * - this process has no registered run for it (killswitch registry),
 * - no worker holds an employee lease for one of its jobs and BullMQ has no active/waiting/delayed
 *   job for it (covers other worker processes and a lead review still waiting for its turn),
 * - and its row is older than ORPHAN_AFTER_MS.
 *
 * Age is the backstop across processes: runTask bumps tasks.updated_at every RUN_HEARTBEAT_MS while a
 * run is in flight (and recordStep's cost update bumps it via $onUpdate for metered steps, but a
 * subscription run can record 0-credit steps only, hence the explicit heartbeat). So even with more
 * than one worker process, a live run never looks 35 minutes old. The final UPDATE re-checks status
 * and updated_at, so a run that wrote a heartbeat or finished in the meantime is never failed.
 * At startup the in-process registry is empty; the age gate and the lease/queue probes protect runs
 * owned by other processes, and this process's own previous runs are dead by definition.
 *
 * The same sweep also unsticks what a dead process can leave behind outside RUNNING runs (each part
 * is idempotent and isolated, so one failing never stops the others):
 * - team leads RUNNING in phase 'wait' whose subtasks have all ended (recheckWaitingLeads),
 * - AWAITING_APPROVAL tasks whose approvals are all resolved (resumeResolvedApprovals),
 * - chat replies left 'streaming' for more than CHAT_TURN_STALE_MS (closed as errors),
 * - dispatched routine runs whose tasks all ended.
 */
export const ORPHAN_AFTER_MS = 35 * 60_000;
export const REAP_EVERY_MS = 5 * 60_000;
export const ORPHAN_ERROR = "orphaned: the run stopped without finishing";

export interface OrphanCandidate {
  id: string;
  workspaceId: string;
  assigneeId: string | null;
  teamId: string | null;
  parentTaskId: string | null;
}

export interface ReaperOptions {
  now?: Date;
  /** ids (of `candidates`) that some worker process is still working on; defaults to the Redis/BullMQ probe */
  liveElsewhere?: (candidates: OrphanCandidate[]) => Promise<Set<string>>;
}

/** Leases (any process) + BullMQ jobs that are active or about to run. */
export async function probeLiveElsewhere(candidates: OrphanCandidate[]): Promise<Set<string>> {
  const live = new Set<string>();
  if (!candidates.length) return live;
  const ids = candidates.map((c) => c.id);

  // executor of each candidate: the assignee, or the team lead for a team-level (parent) task
  const teamIds = [...new Set(candidates.filter((c) => c.teamId && !c.parentTaskId).map((c) => c.teamId!))];
  const leads = teamIds.length ? await db.select({ id: teams.id, leadId: teams.leadId }).from(teams).where(inArray(teams.id, teamIds)) : [];
  const byEmployee = new Map<string, string[]>();
  for (const c of candidates) {
    const lead = c.teamId && !c.parentTaskId ? leads.find((l) => l.id === c.teamId)?.leadId : null;
    for (const emp of new Set([c.assigneeId, lead].filter((x): x is string => !!x))) byEmployee.set(emp, [...(byEmployee.get(emp) ?? []), c.id]);
  }
  for (const [emp, taskIds] of byEmployee) for (const id of await tasksHoldingLease(emp, taskIds)) live.add(id);

  const jobs = await runsQueue.getJobs(["active", "waiting", "delayed", "prioritized", "waiting-children"]);
  for (const j of jobs) {
    const d = j?.data;
    if (d?.kind === "task" && ids.includes(d.taskId)) live.add(d.taskId);
  }
  return live;
}

export interface ReapResult {
  reaped: string[];
  routineRunsSettled: number;
  /** waiting team leads re-checked (onChildFinished; it flips to review only when every subtask ended) */
  leadsChecked: string[];
  /** AWAITING_APPROVAL tasks whose approvals were all resolved, handed back to afterApprovalResolved */
  approvalsResumed: string[];
  /** assistant rows left 'streaming' by a dead chat run, closed as errors */
  chatTurnsClosed: string[];
}

export async function reapOrphanedTasks(opts: ReaperOptions = {}): Promise<ReapResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - ORPHAN_AFTER_MS);
  const stale = await db
    .select({ id: tasks.id, workspaceId: tasks.workspaceId, assigneeId: tasks.assigneeId, teamId: tasks.teamId, parentTaskId: tasks.parentTaskId })
    .from(tasks)
    .where(and(eq(tasks.status, "RUNNING"), or(isNull(tasks.phase), notInArray(tasks.phase, ["wait", "hold"])), lt(tasks.updatedAt, cutoff)))
    .limit(200);
  const candidates = stale.filter((c) => !isTaskRunActive(c.id));

  const reaped: string[] = [];
  if (candidates.length) {
    let live: Set<string> | null = null;
    try {
      live = await (opts.liveElsewhere ?? probeLiveElsewhere)(candidates);
    } catch (e) {
      log.warn({ err: e }, "reaper: liveness probe failed; skipping this sweep"); // never reap blind
    }
    for (const c of live ? candidates : []) {
      if (live!.has(c.id)) continue;
      const failed = await failTask(c, ORPHAN_ERROR, { kind: "orphaned", onlyIfStatus: ["RUNNING"], staleBefore: cutoff });
      if (!failed) continue;
      reaped.push(c.id);
      await recordStep({ workspaceId: c.workspaceId, taskId: c.id, kind: "system", name: "task_reaped", status: "error", output: { reason: ORPHAN_ERROR, staleSince: cutoff.toISOString() } }).catch(
        (e) => log.warn({ err: e, taskId: c.id }, "reaper: step not recorded"),
      );
    }
    if (reaped.length) log.warn({ reaped }, "reaped orphaned RUNNING tasks");
  }

  const leadsChecked = await recheckWaitingLeads(cutoff);
  const approvalsResumed = await resumeResolvedApprovals(cutoff);
  const chatTurnsClosed = await sweep("chat turns", [], async () =>
    (await closeStaleTurns(new Date(now.getTime() - CHAT_TURN_STALE_MS), activeConversationIds())).map((m) => m.id),
  );
  if (chatTurnsClosed.length) log.warn({ chatTurnsClosed }, "closed orphaned streaming chat replies");

  const routineRunsSettled = await settleDispatchedRoutineRuns();
  return { reaped, routineRunsSettled, leadsChecked, approvalsResumed, chatTurnsClosed };
}

/** One sweep of the reaper; a failure is logged and never stops the other sweeps. */
async function sweep<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    log.error({ err: e }, `reaper: ${label} sweep failed`);
    return fallback;
  }
}

/**
 * A team lead RUNNING in phase 'wait' is woken by its last subtask's finisher. A subtask that ended
 * without one (cancelled from the web API, which writes CANCELLED directly; a finisher that died)
 * leaves it waiting forever. onChildFinished is idempotent: it flips wait → review (and enqueues the
 * review) only when every subtask is terminal.
 */
async function recheckWaitingLeads(cutoff: Date): Promise<string[]> {
  return sweep("waiting leads", [], async () => {
    const leads = await db
      .select({ id: tasks.id, workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(and(eq(tasks.status, "RUNNING"), eq(tasks.phase, "wait"), lt(tasks.updatedAt, cutoff)))
      .limit(200);
    for (const l of leads) {
      await onChildFinished(l.workspaceId, l.id).catch((e: unknown) => log.warn({ err: e, taskId: l.id }, "reaper: re-checking a waiting lead failed"));
    }
    return leads.map((l) => l.id);
  });
}

/**
 * AWAITING_APPROVAL with every approval resolved means the resolver died between the approval's
 * commit and afterApprovalResolved (or its failTask). Only tasks quiet since the cutoff, with at
 * least one approval and none still open or decided after the cutoff (the approval job of a fresh
 * decision may still be on its way), are handed to afterApprovalResolved, which is idempotent.
 */
async function resumeResolvedApprovals(cutoff: Date): Promise<string[]> {
  return sweep("resolved approvals", [], async () => {
    const stuck = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "AWAITING_APPROVAL"),
          lt(tasks.updatedAt, cutoff),
          sql`exists (select 1 from approvals a where a.task_id = ${tasks.id})`,
          sql`not exists (select 1 from approvals a where a.task_id = ${tasks.id}
                and (a.status in ('PENDING', 'APPROVED', 'EXECUTING') or a.decided_at > ${cutoff.toISOString()}::timestamptz))`,
        ),
      )
      .limit(200);
    const resumed: string[] = [];
    for (const t of stuck) {
      try {
        await afterApprovalResolved(t.id);
        resumed.push(t.id);
      } catch (e) {
        log.warn({ err: e, taskId: t.id }, "reaper: resuming a resolved approval task failed");
      }
    }
    if (resumed.length) log.warn({ resumed }, "resumed AWAITING_APPROVAL tasks whose approvals were all resolved");
    return resumed;
  });
}
