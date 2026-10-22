import "./lib/env";
import { DelayedError, Worker, type Job } from "bullmq";
import { getSql } from "@wfos/db";
import { QUEUE_ACTIONS, QUEUE_DEPLOYS, QUEUE_INGEST, QUEUE_MISC, QUEUE_RUNS, type ActionJob, type IngestJob, type MiscJob, type RunJob } from "@wfos/shared";
import { env, instanceCredentialSummary } from "./lib/env";
import { log } from "./lib/logger";
import { errorMessage } from "./lib/errors";
import { connection, CONTROL_CHANNEL, newRedis, prefix, redis, type ControlMessage } from "./lib/redis";
import { runTask } from "./runner/task";
import { runChat } from "./runner/chat";
import { executeApproval, handleRejection } from "./runner/approvals";
import { ingestDocument } from "./lib/ingest";
import { notify } from "./lib/notify";
import { runReplay } from "./simulation/replay";
import { runDemoLifecycle } from "./simulation/demo";
import { backfillMemoryEmbeddings, runRoutineJob, tickRoutines } from "./scheduler/routines";
import { tickBilling } from "./scheduler/billing";
import { resendOutbound } from "./lib/outbox";
import { runMergeScan } from "./runner/merge-scan";
import { abortConversation, abortTask, abortWorkspace, activeRunCount } from "./guards/killswitch";
import { acquireRunLeases } from "./runner/run-lease";
import { handleRunJobFailed } from "./runner/task-status";
import { REAP_EVERY_MS, reapOrphanedTasks } from "./scheduler/reaper";
import { MEMORY_TIDY_CHECK_MS, memoryTidyTick } from "./scheduler/memory-tidy";
import { monthlySkillAuditTick, SKILL_AUDIT_CHECK_MS, skillUpdateTick } from "./scheduler/skill-audit";
import { recheckServers, SERVER_RECHECK_TICK_MS } from "./scheduler/servers";
import { APPS_TICK_MS, tickApps } from "./scheduler/apps";
import { tickUptime, UPTIME_TICK_MS } from "./scheduler/uptime";
import { syncSubscriptionUsage, USAGE_SYNC_EVERY_MS } from "./scheduler/usage";
import { cancelClaudeLogin, recoverClaudeLogins, startClaudeLogin, stopClaudeLogins, submitClaudeLoginCode } from "./claude-login";
import { activeDeployCount, drainDeploys, onDeployActivity, processDeployJob, recoverInterruptedReleases, recoverInterruptedRestores, sweepGraceStops } from "./deploy";
import type { WorkerDeployJob } from "./deploy/jobs";
import { collectWorkspaces } from "./runner/workspace/gc";
import { telegramDailySummary } from "./lib/telegram";
import { writeHeartbeat } from "./lib/heartbeat";
import { HEARTBEAT_EVERY_MS } from "@wfos/shared/ops";

// Per-employee and per-division concurrency: Redis lease sets (./runner/run-lease), one member per job.
async function processRun(job: Job<RunJob>, token?: string): Promise<void> {
  const leases = await acquireRunLeases(job.data, `${job.id}`, env.perEmployeeConcurrency);
  if (!leases.ok) {
    // the employee or its division is busy: try again shortly
    await job.moveToDelayed(Date.now() + 4000, token);
    throw new DelayedError();
  }
  try {
    if (job.data.kind === "task") await runTask(job.data.taskId, job.data.resumeNote);
    else if (job.data.kind === "chat_regenerate") await runChat(job.data.conversationId, job.data.userMessageId, { regenerate: true, enqueuedAt: new Date(job.timestamp) });
    else await runChat(job.data.conversationId, job.data.messageId);
  } finally {
    await leases.release();
  }
}

const workers = [
  // Agent runs are not retried automatically by BullMQ: the runner sets FAILED with the reason.
  new Worker<RunJob>(QUEUE_RUNS, processRun, { connection, prefix, concurrency: env.concurrency, lockDuration: 10 * 60 * 1000, maxStalledCount: 0 }),
  new Worker<ActionJob>(
    QUEUE_ACTIONS,
    async (job) => {
      if (job.data.kind === "execute_approval") await executeApproval(job.data.approvalId);
      else await handleRejection(job.data.approvalId);
    },
    { connection, prefix, concurrency: 2 },
  ),
  new Worker<IngestJob>(QUEUE_INGEST, async (job) => ingestDocument(job.data.documentId), { connection, prefix, concurrency: 1 }),
  new Worker<MiscJob>(
    QUEUE_MISC,
    async (job) => {
      const d = job.data;
      switch (d.kind) {
        case "notify":
          return notify(d);
        case "replay":
          return runReplay(d.replayId);
        case "demo":
          return runDemoLifecycle(d.workspaceId, d.userId);
        case "routine_run":
          await runRoutineJob(d.routineId, d.userId);
          return;
        case "outbox_resend":
          await resendOutbound(d.emailId, d.workspaceId, d.userId);
          return;
        case "merge_scan":
          await runMergeScan(d.workspaceId, d.repositoryId);
          return;
      }
    },
    { connection, prefix, concurrency: 2, lockDuration: 10 * 60 * 1000 },
  ),
];

// a Connect Claude sign-in of the previous worker process cannot finish: tell the page and remove its HOME
void getSql()<{ id: string }[]>`select id from workspaces`
  .then((rows) => recoverClaudeLogins(rows.map((r) => r.id)))
  .catch((e: unknown) => log.error({ err: errorMessage(e) }, "recovering claude sign-ins failed"));

// App deploys and start/stop/remove: one job at a time (one build per server). Not started until releases a dead
// process left behind are settled (recoverInterruptedReleases), so a job taken now is never mistaken for one.
const deployWorker = new Worker<WorkerDeployJob>(QUEUE_DEPLOYS, processDeployJob, {
  connection,
  prefix,
  concurrency: 1,
  lockDuration: 10 * 60 * 1000,
  maxStalledCount: 0,
  autorun: false,
});
// then a database restore cut off by the stop (the app started again or the maintenance page left on, Owners told),
// and live grace stops whose job was lost (the old slot of a release would otherwise keep running)
void recoverInterruptedReleases()
  .catch((e) => log.error({ err: e }, "recovering interrupted releases failed"))
  .then(() => recoverInterruptedRestores())
  .catch((e) => log.error({ err: e }, "recovering interrupted restores failed"))
  .then(() => sweepGraceStops())
  .catch((e) => log.error({ err: e }, "sweeping live grace stops failed"))
  .finally(() => void deployWorker.run().catch((e: unknown) => log.error({ err: e }, "deploy worker stopped")));

for (const w of [...workers, deployWorker]) {
  w.on("failed", (job, err) => log.error({ queue: w.name, jobId: job?.id, err: errorMessage(err) }, "job failed"));
  w.on("error", (err) => log.error({ queue: w.name, err: errorMessage(err) }, "worker error"));
}

// Mark agent runs whose job exhausted / stalled as failed rather than leaving them RUNNING (chat: close the turn).
workers[0]!.on("failed", (job) => {
  if (job) void handleRunJobFailed(job as Job<RunJob>).catch((e) => log.error({ err: e, jobId: job.id }, "failing the task of a failed job failed"));
});

// ---------------------------------------------------------------------------
// Kill switch / cancellation: control channel aborts in-flight runs immediately.
// ---------------------------------------------------------------------------
const sub = newRedis();
sub.subscribe(CONTROL_CHANNEL).catch((e: unknown) => log.error({ err: e }, "control channel subscribe failed"));
sub.on("message", (_ch, raw) => {
  try {
    const msg = JSON.parse(raw) as ControlMessage;
    if (msg.type === "kill") abortWorkspace(msg.workspaceId, "Stopped by kill switch");
    if (msg.type === "cancel_task") abortTask(msg.taskId, "Cancelled by user");
    if (msg.type === "abort_conversation") abortConversation(msg.conversationId);
    const claudeLogin = (p: Promise<void>) => void p.catch((e: unknown) => log.error({ err: errorMessage(e), type: msg.type }, "claude sign-in step failed"));
    if (msg.type === "claude_login_start") claudeLogin(startClaudeLogin(msg));
    if (msg.type === "claude_login_code") claudeLogin(submitClaudeLoginCode(msg));
    if (msg.type === "claude_login_cancel") claudeLogin(cancelClaudeLogin(msg));
  } catch (e) {
    log.warn({ err: e }, "bad control message");
  }
});

// ---------------------------------------------------------------------------
// Scheduler: routines and recurring billing every 30s; memory embedding backfill every 2 min; orphan reaper every 5 min.
// ---------------------------------------------------------------------------
let ticking = false;
const schedTimer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await tickRoutines();
  } catch (e) {
    log.error({ err: e }, "routine tick failed");
  }
  try {
    await tickBilling();
  } catch (e) {
    log.error({ err: e }, "billing tick failed");
  } finally {
    ticking = false;
  }
}, 30_000);
// Stale RUNNING tasks (crashed / restarted worker, a run that threw) → FAILED; settles routine runs.
// Assumes one worker process; with more, the reaper's age gate + lease/queue probes keep live runs safe.
let reaping = false;
const reap = async () => {
  if (reaping) return;
  reaping = true;
  try {
    await reapOrphanedTasks();
  } catch (e) {
    log.error({ err: e }, "orphan reaper failed");
  } finally {
    reaping = false;
  }
};
const reapTimer = setInterval(() => void reap(), REAP_EVERY_MS);
void reap(); // at startup the run registry is empty; only rows older than the orphan age are touched
// Workspace mode: remove task workspaces after WORKSPACE_RETENTION_DAYS (deliverables stay)
const gcTimer = setInterval(() => void collectWorkspaces().then((n) => n && log.info({ n }, "workspaces collected")).catch((e) => log.warn({ err: e }, "workspace gc failed")), 3_600_000);
// health: /api/health treats a missing or old heartbeat as "worker down"
const beat = () => void writeHeartbeat().catch((e) => log.warn({ err: e }, "heartbeat failed"));
const heartbeatTimer = setInterval(beat, HEARTBEAT_EVERY_MS);
beat();
// a deploy job starting or ending is reported at once (deploy/upgrade.sh waits on activeDeploys)
onDeployActivity(() => writeHeartbeat());
const summaryTimer = setInterval(() => void telegramDailySummary().catch((e) => log.warn({ err: e }, "telegram summary failed")), 10 * 60_000);
const backfillTimer = setInterval(() => void backfillMemoryEmbeddings().catch((e) => log.warn({ err: e }, "backfill failed")), 120_000);
// nightly memory tidy at 02:00 APP_TIME_ZONE (checked every 10 min, claimed once per day in Redis)
const tidyTimer = setInterval(() => void memoryTidyTick().catch((e) => log.warn({ err: e }, "memory tidy failed")), MEMORY_TIDY_CHECK_MS);
// C4: the monthly skill audit (1st, 09:00) and the daily catalog update check (04:00), APP_TIME_ZONE, claimed in Redis
const skillAuditTimer = setInterval(() => {
  void monthlySkillAuditTick().catch((e) => log.warn({ err: e }, "monthly skill audit failed"));
  void skillUpdateTick().catch((e) => log.warn({ err: e }, "skill update check failed"));
}, SKILL_AUDIT_CHECK_MS);
// app servers: each verified server is probed again hourly (looked for every 10 min); ready → error notifies Owners
let rechecking = false;
const recheck = async () => {
  if (rechecking) return;
  rechecking = true;
  try {
    await recheckServers();
  } catch (e) {
    log.warn({ err: e }, "server re-check failed");
  } finally {
    rechecking = false;
  }
};
const serversTimer = setInterval(() => void recheck(), SERVER_RECHECK_TICK_MS);
// apps: hourly health of running previews (notify on healthy → unhealthy) and the idle auto-stop
let appsTicking = false;
const appsTick = async () => {
  if (appsTicking) return;
  appsTicking = true;
  try {
    await tickApps();
  } catch (e) {
    log.warn({ err: e }, "apps tick failed");
  } finally {
    appsTicking = false;
  }
};
const appsTimer = setInterval(() => void appsTick(), APPS_TICK_MS);
// LIVE uptime: each running LIVE site every UPTIME_CHECK_EVERY_MS (3 tries per check, down after 2 failed checks)
let uptimeTicking = false;
const uptimeTick = async () => {
  if (uptimeTicking) return;
  uptimeTicking = true;
  try {
    await tickUptime();
  } catch (e) {
    log.warn({ err: e }, "uptime tick failed");
  } finally {
    uptimeTicking = false;
  }
};
const uptimeTimer = setInterval(() => void uptimeTick(), UPTIME_TICK_MS);
// Claude subscription usage (claude_limits) from Claude itself: every 15 min per subscription credential, no tokens spent
let usageSyncing = false;
const usageTick = async () => {
  if (usageSyncing) return;
  usageSyncing = true;
  try {
    const r = await syncSubscriptionUsage();
    if (r.fetched) log.info(r, "subscription usage synced");
  } finally {
    usageSyncing = false;
  }
};
const usageTimer = setInterval(() => void usageTick(), USAGE_SYNC_EVERY_MS);
const usageFirst = setTimeout(() => void usageTick(), 60_000);
void tickRoutines().catch((e) => log.error({ err: e }, "initial routine tick failed"));

log.info(
  { concurrency: env.concurrency, perEmployee: env.perEmployeeConcurrency, instanceCredential: instanceCredentialSummary() },
  "Workforce OS worker started",
);

async function shutdown(sig: string) {
  log.info({ sig, active: activeRunCount(), deploys: activeDeployCount() }, "shutting down");
  clearInterval(schedTimer);
  clearInterval(reapTimer);
  clearInterval(backfillTimer);
  clearInterval(tidyTimer);
  clearInterval(skillAuditTimer);
  clearInterval(serversTimer);
  clearInterval(appsTimer);
  clearInterval(uptimeTimer);
  clearInterval(usageTimer);
  clearTimeout(usageFirst);
  clearInterval(gcTimer);
  clearInterval(summaryTimer);
  clearInterval(heartbeatTimer);
  stopClaudeLogins();
  // a running deploy gets up to 60 s to finish its step (one that has not switched anything on stops cleanly)
  await Promise.allSettled([...workers.map((w) => w.close()), drainDeploys(() => deployWorker.close())]);
  sub.disconnect();
  redis.disconnect();
  await getSql().end({ timeout: 5 });
  process.exit(0);
}
const onSignal = (sig: string) => () =>
  void shutdown(sig).catch((e: unknown) => {
    log.error({ err: e, sig }, "shutdown failed");
    process.exit(1);
  });
process.on("SIGINT", onSignal("SIGINT"));
process.on("SIGTERM", onSignal("SIGTERM"));
