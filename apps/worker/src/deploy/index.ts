import { stat } from "node:fs/promises";
import { DelayedError, type Job } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { appReleases, audit, db } from "@wfos/db";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { deploysQueue } from "../lib/redis";
import { runAppAction } from "./actions";
import { runDbJob } from "./backups";
import type { WorkerDeployJob } from "./jobs";
import { runSlotStop } from "./slots";
import { publishRelease } from "./common";
import { deployControl, handBack, runRelease, settleInterrupted } from "./pipeline";

export { deployControl } from "./pipeline";
export { recoverInterruptedRestores, queueDailyBackups } from "./backups";
export { sweepGraceStops } from "./slots";

let active = 0;
/** Deploy-queue jobs running in this process now (0/1): the heartbeat reports it, upgrade.sh waits for 0. */
export function activeDeployCount(): number {
  return active;
}

/**
 * Called when a deploy job starts and when it ends; index.ts writes the heartbeat there, so /api/health shows the
 * change at once (not up to HEARTBEAT_EVERY_MS later) and upgrade.sh never misses a deploy that just started.
 */
let onActivity: () => Promise<void> = async () => {};
export function onDeployActivity(fn: () => Promise<void>): void {
  onActivity = fn;
}
const signal = () => onActivity().catch((e: unknown) => log.warn({ err: e }, "heartbeat after a deploy job change failed"));

/** A held job is looked at again after this long. */
export const DEPLOY_HOLD_DELAY_MS = 30_000;
/** A hold file older than this is left over from an upgrade that died: ignored. */
export const DEPLOY_HOLD_STALE_MS = 2 * 60 * 60_000;

/** True while deploy/upgrade.sh holds app deploys (env.deploysHoldFile exists and is not stale). */
export async function deploysHeld(now = Date.now()): Promise<boolean> {
  const st = await stat(env.deploysHoldFile).catch(() => null);
  if (!st) return false;
  if (now - st.mtimeMs > DEPLOY_HOLD_STALE_MS) {
    log.warn({ file: env.deploysHoldFile, since: st.mtime.toISOString() }, "stale deploy hold file ignored");
    return false;
  }
  return true;
}

/**
 * The deploys queue's processor (concurrency 1: one build at a time on this worker, so per server). While an upgrade
 * holds deploys, the job is put back (delayed) without running.
 */
export async function processDeployJob(job: Job<WorkerDeployJob>, token?: string): Promise<void> {
  // counted (and the heartbeat written) BEFORE the hold is looked at: a job that sees no hold file is already
  // visible as activeDeploys 1, so upgrade.sh, which creates the file and then reads the health, cannot miss it
  active++;
  await signal();
  if (await deploysHeld()) {
    active--;
    await signal();
    log.info({ jobId: job.id }, "deploy held by an upgrade: delayed");
    await job.moveToDelayed(Date.now() + DEPLOY_HOLD_DELAY_MS, token);
    throw new DelayedError();
  }
  try {
    const d = job.data;
    if (d.kind === "release") await runRelease(d.releaseId, d.workspaceId);
    else if (d.kind === "app_action") await runAppAction(d);
    else if (d.kind === "db_backup" || d.kind === "db_restore") await runDbJob(d);
    else if (d.kind === "slot_stop") await runSlotStop(d);
  } finally {
    active--;
    await signal();
  }
}

/** On shutdown: no new pre-activate step starts; resolves when the running job ends or after `maxMs`. */
export async function drainDeploys(close: () => Promise<void>, maxMs = 60_000): Promise<void> {
  deployControl.stopping = true;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([close(), new Promise<void>((r) => (timer = setTimeout(r, maxMs)))]);
  clearTimeout(timer);
  if (active) log.warn({ active }, "deploy still running at shutdown: it is marked interrupted at the next start");
}

/**
 * At worker start (before the deploys worker takes jobs): a release left `deploying` (its process died) is settled
 * by settleInterrupted (undone like a live failure when it had switched or migrated anything, else failed with
 * "interrupted" and the app back to its status before); a `queued` one without a job waiting in the queue is failed
 * with "interrupted" (it never touched the app). Returns the ids of the releases settled.
 */
export async function recoverInterruptedReleases(): Promise<string[]> {
  const rows = await db.select().from(appReleases).where(inArray(appReleases.status, ["queued", "deploying"]));
  if (!rows.length) return [];
  const waiting = new Set<string>();
  for (const j of await deploysQueue.getJobs(["waiting", "delayed", "prioritized", "waiting-children"])) {
    if (j?.data?.kind === "release") waiting.add(j.data.releaseId);
  }
  const settled: string[] = [];
  for (const r of rows) {
    try {
      if (r.status === "deploying") {
        const status = await settleInterrupted(r);
        settled.push(r.id);
        log.warn({ releaseId: r.id, step: r.step, status }, "interrupted release settled");
        continue;
      }
      if (waiting.has(r.id)) continue;
      if (await failQueuedRelease(r, "interrupted")) settled.push(r.id);
    } catch (e) {
      log.error({ err: e, releaseId: r.id }, "interrupted release could not be settled");
    }
  }
  return settled;
}

/**
 * A `queued` release no job will ever run: failed with `reason` (it never touched its environment), audited, and handed
 * back to the task that asked for it. Conditional on `queued`: false when it started (or ended) meanwhile.
 */
async function failQueuedRelease(r: { id: string }, reason: "interrupted" | "lost"): Promise<boolean> {
  const [row] = await db
    .update(appReleases)
    .set({ status: "failed", error: reason, finishedAt: new Date() })
    .where(and(eq(appReleases.id, r.id), eq(appReleases.status, "queued")))
    .returning();
  if (!row) return false;
  await publishRelease(row);
  await audit({
    workspaceId: row.workspaceId,
    actorLabel: "system",
    action: "app.deploy_failed",
    targetType: "app",
    targetId: row.appId,
    details: { releaseId: row.id, environmentId: row.environmentId, commit: row.commit || null, branch: row.branch, trigger: row.trigger, step: row.step, error: reason },
  });
  await handBack(row.id);
  return true;
}

/** A queued release without a job this old is lost (a normal job starts within seconds, or waits behind one build). */
export const LOST_QUEUED_RELEASE_MS = 15 * 60_000;
/** A deploying release whose step and log did not change for this long, with nothing running it, is lost. */
export const LOST_DEPLOYING_RELEASE_MS = 30 * 60_000;
/** what the sweep last saw of each deploying release: step + log length, and since when */
const progressSeen = new Map<string, { mark: string; since: number }>();

/**
 * Reaper sweep (recovery at boot covers a restart; this covers a job lost while the worker keeps running):
 * - `queued` releases older than LOST_QUEUED_RELEASE_MS with no job in the deploys queue → failed "lost";
 * - `deploying` releases without progress (step and log unchanged across sweeps) for LOST_DEPLOYING_RELEASE_MS, no
 *   active job in the queue, and no deploy running in this process → settled like an interrupted one, "lost"
 *   (undone on the server when it had switched or migrated anything).
 * Each one is handed back to its task (a preview the task waits for). Returns the ids settled.
 */
export async function sweepLostReleases(now: number = Date.now()): Promise<string[]> {
  const rows = await db.select().from(appReleases).where(inArray(appReleases.status, ["queued", "deploying"]));
  for (const id of progressSeen.keys()) if (!rows.some((r) => r.id === id && r.status === "deploying")) progressSeen.delete(id);
  if (!rows.length) return [];
  const jobs = new Set<string>();
  for (const j of await deploysQueue.getJobs(["active", "waiting", "delayed", "prioritized", "waiting-children"])) {
    if (j?.data?.kind === "release") jobs.add(j.data.releaseId);
  }
  const settled: string[] = [];
  for (const r of rows) {
    try {
      if (r.status === "queued") {
        if (jobs.has(r.id) || now - r.createdAt.getTime() < LOST_QUEUED_RELEASE_MS) continue;
        if (await failQueuedRelease(r, "lost")) settled.push(r.id);
        continue;
      }
      const mark = `${r.step ?? ""}:${r.log.length}`;
      const seen = progressSeen.get(r.id);
      if (!seen || seen.mark !== mark) {
        progressSeen.set(r.id, { mark, since: now });
        continue;
      }
      if (now - seen.since < LOST_DEPLOYING_RELEASE_MS || jobs.has(r.id) || active > 0) continue;
      const [still] = await db.select().from(appReleases).where(and(eq(appReleases.id, r.id), eq(appReleases.status, "deploying")));
      if (!still) continue;
      progressSeen.delete(r.id);
      const status = await settleInterrupted(still, "lost");
      log.warn({ releaseId: r.id, step: r.step, status }, "lost release settled");
      settled.push(r.id);
    } catch (e) {
      log.error({ err: e, releaseId: r.id }, "lost release could not be settled");
    }
  }
  return settled;
}
