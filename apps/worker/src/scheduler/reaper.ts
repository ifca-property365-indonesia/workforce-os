import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, employees, tasks, teams, webhookDeliveries, workspaces } from "@wfos/db";
import { enqueueTask, runsQueue } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { log } from "../lib/logger";
import { pruneToolOutputs } from "../lib/tool-outputs";
import { retriageStuckDeliveries } from "../runner/webhook-triage";
import { advanceStuckWorkflowRuns } from "../runner/workflows";
import { activeConversationIds, isTaskRunActive } from "../guards/killswitch";
import { tasksHoldingLease } from "../guards/lease";
import { failTask, settleDispatchedRoutineRuns } from "../runner/task-status";
import { afterApprovalResolved, expireUnansweredApprovals, handBackMissedReleases } from "../runner/approvals";
import { sweepLostReleases } from "../deploy";
import { onChildFinished } from "../orchestration/team";
import { DEPENDENCY_PHASES } from "../orchestration/phases";
import { CHAT_TURN_STALE_MS, closeStaleTurns } from "../runner/chat-turns";
import { activeQuotaPause } from "../lib/limits";
import { failStuckSends } from "../lib/outbox";

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
 * - dispatched routine runs whose tasks all ended,
 * - QUEUED tasks older than LOST_QUEUED_AFTER_MS that no BullMQ job will ever run (the enqueue was lost):
 *   re-enqueued, unless held (phase hold), an ordered subtask waiting for or blocked by its dependencies, behind the kill switch, a quota pause or an employee that is not active,
 * - webhook deliveries older than WEBHOOK_DELIVERY_RETENTION_MS (deleted in batches),
 * - waiting workflow runs whose task or approval already settled (advanceStuckWorkflowRuns),
 * - webhook deliveries stuck in triage (their job was lost), asked again (retriageStuckDeliveries),
 * - PENDING approvals past their workspace's approval_expiry_hours, expired unanswered (expireUnansweredApprovals),
 * - saved large tool results (read_output handles): emptied once expired, deleted after OUTPUT_STATS_RETENTION_MS,
 * - outbox rows left `sending` for more than STUCK_SENDING_MS (failed with an "interrupted, check before resending" note),
 * - app releases whose job was lost (queued) or whose worker died (deploying, no progress), settled "lost", and settled
 *   preview releases whose hand-back to the waiting task was missed (sweepLostReleases, handBackMissedReleases).
 */
export const ORPHAN_AFTER_MS = 35 * 60_000;
export const REAP_EVERY_MS = 5 * 60_000;
export const ORPHAN_ERROR = "orphaned: the run stopped without finishing";
/** A QUEUED task this old without a job is re-enqueued (a normal enqueue lands within seconds). */
export const LOST_QUEUED_AFTER_MS = 10 * 60_000;
/** Inbound webhook deliveries are kept this long (the log in Settings; idempotency keys older than this are forgotten). */
export const WEBHOOK_DELIVERY_RETENTION_MS = 30 * 24 * 3_600_000;
const PRUNE_BATCH = 1000;
/** at most this many batches per sweep: a large backlog is worked off over several sweeps */
const PRUNE_MAX_BATCHES = 20;

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
  /** QUEUED tasks without a job, enqueued again */
  requeued: string[];
  /** webhook deliveries deleted for age */
  webhookDeliveriesPruned: number;
  /** waiting workflow runs whose task or approval had settled, moved on */
  workflowRunsAdvanced: string[];
  /** webhook deliveries whose triage job was lost, enqueued again */
  deliveriesRetriaged: string[];
  /** approvals nobody decided in time, expired (fail closed) */
  approvalsExpired: string[];
  /** saved large tool results emptied after they expired, or deleted for age */
  toolOutputsPruned: number;
  /** outbox rows stuck in `sending`, marked failed */
  stuckEmailsFailed: string[];
  /** app releases left queued without a job, or deploying without progress, settled failed "lost" */
  releasesLost: string[];
  /** settled preview releases handed back to their waiting task (the hand-back after the deploy was missed) */
  releasesHandedBack: string[];
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
  // preview releases first: a lost one is settled and a missed hand-back done before resolved approvals close a task
  const releasesLost = await sweep("lost releases", [], () => sweepLostReleases(now.getTime()));
  if (releasesLost.length) log.warn({ releasesLost }, "reaper: lost releases settled");
  const releasesHandedBack = await sweep("release hand-back", [], () => handBackMissedReleases(now));
  if (releasesHandedBack.length) log.warn({ releasesHandedBack }, "reaper: settled releases handed back to their tasks");
  const approvalsResumed = await resumeResolvedApprovals(cutoff);
  const chatTurnsClosed = await sweep("chat turns", [], async () =>
    (await closeStaleTurns(new Date(now.getTime() - CHAT_TURN_STALE_MS), activeConversationIds())).map((m) => m.id),
  );
  if (chatTurnsClosed.length) log.warn({ chatTurnsClosed }, "closed orphaned streaming chat replies");

  const requeued = await requeueLostTasks(now, opts.liveElsewhere ?? probeLiveElsewhere);
  const webhookDeliveriesPruned = await sweep("webhook deliveries", 0, () => pruneWebhookDeliveries(now));
  const toolOutputsPruned = await sweep("tool outputs", 0, () => pruneToolOutputs(now));
  const approvalsExpired = await sweep("approval expiry", [], () => expireUnansweredApprovals(now));
  const deliveriesRetriaged = await sweep("webhook triage", [], () => retriageStuckDeliveries(now));
  const workflowRunsAdvanced = await sweep("workflow runs", [], () => advanceStuckWorkflowRuns(now));
  if (deliveriesRetriaged.length) log.warn({ deliveriesRetriaged }, "reaper: webhook deliveries stuck in triage enqueued again");
  if (approvalsExpired.length) log.warn({ approvalsExpired }, "reaper: approvals nobody decided in time expired");
  const stuckEmailsFailed = await sweep("outbox sending", [], () => failStuckSends(now));
  if (stuckEmailsFailed.length) log.warn({ stuckEmailsFailed }, "reaper: outbox rows stuck in sending marked failed");

  const routineRunsSettled = await settleDispatchedRoutineRuns();
  return { reaped, routineRunsSettled, leadsChecked, approvalsResumed, chatTurnsClosed, requeued, webhookDeliveriesPruned, toolOutputsPruned, approvalsExpired, deliveriesRetriaged, workflowRunsAdvanced, stuckEmailsFailed, releasesLost, releasesHandedBack };
}

/**
 * QUEUED tasks whose enqueue was lost (the web or a worker died between the insert and the queue add, Redis was
 * down): nothing would ever run them. Re-enqueued when older than LOST_QUEUED_AFTER_MS and BullMQ has no
 * active/waiting/delayed job for them (the same probe as the orphan reaper; never blind: a failed probe skips the
 * sweep). Left alone: held tasks (phase hold), workspaces behind the kill switch or a quota pause (their tasks
 * are released when it lifts), and tasks whose executor is not ACTIVE (paused, budget): runTask would only
 * record "not active" again. runTask re-checks the status, so a task that moved on meanwhile is skipped there.
 */
async function requeueLostTasks(now: Date, liveElsewhere: (c: OrphanCandidate[]) => Promise<Set<string>>): Promise<string[]> {
  return sweep("lost queued tasks", [], async () => {
    const cutoff = new Date(now.getTime() - LOST_QUEUED_AFTER_MS);
    const rows = await db
      .select({ id: tasks.id, workspaceId: tasks.workspaceId, assigneeId: tasks.assigneeId, teamId: tasks.teamId, parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      // ordered subtasks waiting for (after) or blocked by their dependencies have no job on purpose: onChildFinished starts them
      .where(and(eq(tasks.status, "QUEUED"), or(isNull(tasks.phase), notInArray(tasks.phase, ["hold", "wait", ...DEPENDENCY_PHASES])), lt(tasks.updatedAt, cutoff), eq(workspaces.killSwitch, false)))
      .limit(100);
    if (!rows.length) return [];

    // the executor (assignee, or the team lead of a team-level task) must be ACTIVE
    const teamIds = [...new Set(rows.filter((r) => r.teamId && !r.parentTaskId).map((r) => r.teamId!))];
    const leads = teamIds.length ? await db.select({ id: teams.id, leadId: teams.leadId }).from(teams).where(inArray(teams.id, teamIds)) : [];
    const executor = (r: OrphanCandidate) => (r.teamId && !r.parentTaskId ? (leads.find((l) => l.id === r.teamId)?.leadId ?? r.assigneeId) : r.assigneeId);
    const empIds = [...new Set(rows.map(executor).filter((x): x is string => !!x))];
    const inactive = new Set(
      empIds.length
        ? (await db.select({ id: employees.id, status: employees.status }).from(employees).where(inArray(employees.id, empIds))).filter((e) => e.status !== "ACTIVE").map((e) => e.id)
        : [],
    );
    const paused = new Set<string>();
    for (const ws of new Set(rows.map((r) => r.workspaceId))) if (await activeQuotaPause(ws)) paused.add(ws);
    const candidates = rows.filter((r) => !paused.has(r.workspaceId) && !inactive.has(executor(r) ?? ""));
    if (!candidates.length) return [];

    let live: Set<string>;
    try {
      live = await liveElsewhere(candidates);
    } catch (e) {
      log.warn({ err: e }, "reaper: job probe failed; not re-enqueueing queued tasks"); // never enqueue blind
      return [];
    }
    const requeued: string[] = [];
    for (const c of candidates) {
      if (live.has(c.id)) continue;
      try {
        await enqueueTask(c.id, c.workspaceId);
      } catch (e) {
        log.warn({ err: e, taskId: c.id }, "reaper: re-enqueueing a queued task failed");
        continue;
      }
      requeued.push(c.id);
      await recordStep({ workspaceId: c.workspaceId, taskId: c.id, kind: "system", name: "task_requeued", output: { reason: "queued without a job", queuedBefore: cutoff.toISOString() } }).catch(
        (e: unknown) => log.warn({ err: e, taskId: c.id }, "reaper: step not recorded"),
      );
    }
    if (requeued.length) log.warn({ requeued }, "re-enqueued QUEUED tasks that had no job");
    return requeued;
  });
}

/** Delete webhook deliveries past their retention, PRUNE_BATCH rows per statement. Returns how many were deleted. */
export async function pruneWebhookDeliveries(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS);
  let total = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
    const rows = await db
      .delete(webhookDeliveries)
      .where(
        inArray(
          webhookDeliveries.id,
          db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, cutoff)).limit(PRUNE_BATCH),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    total += rows.length;
    if (rows.length < PRUNE_BATCH) break;
  }
  if (total) log.info({ pruned: total, before: cutoff.toISOString() }, "reaper: pruned old webhook deliveries");
  return total;
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
          // waiting on a preview the platform is still deploying (afterReleaseSettled resumes it)
          sql`not exists (select 1 from app_releases r where r.task_id = ${tasks.id} and r.status in ('queued', 'deploying'))`,
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
