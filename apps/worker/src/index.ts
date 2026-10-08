import "./lib/env";
import { DelayedError, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { conversations, db, getSql, routines, tasks, teams } from "@wfos/db";
import { QUEUE_ACTIONS, QUEUE_INGEST, QUEUE_MISC, QUEUE_RUNS, type ActionJob, type IngestJob, type MiscJob, type RunJob } from "@wfos/shared";
import { env, instanceCredentialSummary } from "./lib/env";
import { log } from "./lib/logger";
import { connection, CONTROL_CHANNEL, newRedis, prefix, redis, type ControlMessage } from "./lib/redis";
import { runTask } from "./runner/task";
import { runChat } from "./runner/chat";
import { executeApproval, handleRejection } from "./runner/approvals";
import { ingestDocument } from "./lib/ingest";
import { notify } from "./lib/notify";
import { runReplay } from "./simulation/replay";
import { runDemoLifecycle } from "./simulation/demo";
import { backfillMemoryEmbeddings, dispatchRoutine, tickRoutines } from "./scheduler/routines";
import { abortTask, abortWorkspace, activeRunCount } from "./guards/killswitch";
import { collectWorkspaces } from "./runner/workspace/gc";
import { telegramDailySummary } from "./lib/telegram";
import { writeHeartbeat } from "./lib/heartbeat";
import { HEARTBEAT_EVERY_MS } from "@wfos/shared/ops";

// ---------------------------------------------------------------------------
// Per-employee concurrency: a lease set in Redis (stale leases expire after 30 min).
// ---------------------------------------------------------------------------
const LEASE_TTL_MS = 30 * 60 * 1000;

async function acquireEmployeeLease(employeeId: string, leaseId: string): Promise<boolean> {
  const key = `wfos:emp-lease:${employeeId}`;
  const now = Date.now();
  const res = await redis
    .multi()
    .zremrangebyscore(key, 0, now - LEASE_TTL_MS)
    .zadd(key, now, leaseId)
    .zcard(key)
    .pexpire(key, LEASE_TTL_MS)
    .exec();
  const count = Number(res?.[2]?.[1] ?? 0);
  if (count > env.perEmployeeConcurrency) {
    await redis.zrem(key, leaseId);
    return false;
  }
  return true;
}

async function releaseEmployeeLease(employeeId: string, leaseId: string): Promise<void> {
  await redis.zrem(`wfos:emp-lease:${employeeId}`, leaseId);
}

async function employeeForRun(data: RunJob): Promise<string | null> {
  if (data.kind === "task") {
    const [t] = await db.select({ assigneeId: tasks.assigneeId, teamId: tasks.teamId, parentTaskId: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, data.taskId));
    if (!t) return null;
    if (t.teamId && !t.parentTaskId) {
      const [team] = await db.select({ leadId: teams.leadId }).from(teams).where(eq(teams.id, t.teamId));
      return team?.leadId ?? t.assigneeId;
    }
    return t.assigneeId;
  }
  const [c] = await db.select({ employeeId: conversations.employeeId, teamId: conversations.teamId }).from(conversations).where(eq(conversations.id, data.conversationId));
  if (c?.employeeId) return c.employeeId;
  if (c?.teamId) {
    const [team] = await db.select({ leadId: teams.leadId }).from(teams).where(eq(teams.id, c.teamId));
    return team?.leadId ?? null;
  }
  return null;
}

async function processRun(job: Job<RunJob>, token?: string): Promise<void> {
  const employeeId = await employeeForRun(job.data);
  const leaseId = `${job.id}`;
  if (employeeId && !(await acquireEmployeeLease(employeeId, leaseId))) {
    await job.moveToDelayed(Date.now() + 4000, token);
    throw new DelayedError();
  }
  try {
    if (job.data.kind === "task") await runTask(job.data.taskId, job.data.resumeNote);
    else await runChat(job.data.conversationId, job.data.messageId);
  } finally {
    if (employeeId) await releaseEmployeeLease(employeeId, leaseId);
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
          return notify(d.workspaceId, d.subject, d.text, d.link, d.approvalId);
        case "replay":
          return runReplay(d.replayId);
        case "demo":
          return runDemoLifecycle(d.workspaceId, d.userId);
        case "routine_run": {
          const [r] = await db.select().from(routines).where(eq(routines.id, d.routineId));
          if (r) await dispatchRoutine(r, "manual", d.userId);
          return;
        }
      }
    },
    { connection, prefix, concurrency: 2, lockDuration: 10 * 60 * 1000 },
  ),
];

for (const w of workers) {
  w.on("failed", (job, err) => log.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"));
  w.on("error", (err) => log.error({ queue: w.name, err: err.message }, "worker error"));
}

// Mark agent runs whose job exhausted / stalled as failed rather than leaving them RUNNING.
workers[0]!.on("failed", async (job) => {
  if (job?.data.kind === "task" && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    const [t] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, job.data.taskId));
    if (t?.status === "RUNNING") await db.update(tasks).set({ status: "FAILED", error: `Worker error: ${job.failedReason}` }).where(eq(tasks.id, job.data.taskId));
  }
});

// ---------------------------------------------------------------------------
// Kill switch / cancellation: control channel aborts in-flight runs immediately.
// ---------------------------------------------------------------------------
const sub = newRedis();
void sub.subscribe(CONTROL_CHANNEL);
sub.on("message", (_ch, raw) => {
  try {
    const msg = JSON.parse(raw) as ControlMessage;
    if (msg.type === "kill") abortWorkspace(msg.workspaceId, "Stopped by kill switch");
    if (msg.type === "cancel_task") abortTask(msg.taskId, "Cancelled by user");
  } catch (e) {
    log.warn({ err: e }, "bad control message");
  }
});

// ---------------------------------------------------------------------------
// Scheduler: routines every 30s; memory embedding backfill every 2 min.
// ---------------------------------------------------------------------------
let ticking = false;
const schedTimer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await tickRoutines();
  } catch (e) {
    log.error({ err: e }, "routine tick failed");
  } finally {
    ticking = false;
  }
}, 30_000);
// Workspace mode: remove task workspaces after WORKSPACE_RETENTION_DAYS (deliverables stay)
const gcTimer = setInterval(() => void collectWorkspaces().then((n) => n && log.info({ n }, "workspaces collected")).catch((e) => log.warn({ err: e }, "workspace gc failed")), 3_600_000);
// health: /api/health treats a missing or old heartbeat as "worker down"
const beat = () => void writeHeartbeat().catch((e) => log.warn({ err: e }, "heartbeat failed"));
const heartbeatTimer = setInterval(beat, HEARTBEAT_EVERY_MS);
beat();
const summaryTimer = setInterval(() => void telegramDailySummary().catch((e) => log.warn({ err: e }, "telegram summary failed")), 10 * 60_000);
const backfillTimer = setInterval(() => void backfillMemoryEmbeddings().catch((e) => log.warn({ err: e }, "backfill failed")), 120_000);
void tickRoutines().catch((e) => log.error({ err: e }, "initial routine tick failed"));

log.info(
  { concurrency: env.concurrency, perEmployee: env.perEmployeeConcurrency, instanceCredential: instanceCredentialSummary() },
  "Workforce OS worker started",
);

async function shutdown(sig: string) {
  log.info({ sig, active: activeRunCount() }, "shutting down");
  clearInterval(schedTimer);
  clearInterval(backfillTimer);
  clearInterval(gcTimer);
  clearInterval(summaryTimer);
  clearInterval(heartbeatTimer);
  await Promise.allSettled(workers.map((w) => w.close()));
  sub.disconnect();
  redis.disconnect();
  await getSql().end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
