import { and, eq, sql } from "drizzle-orm";
import { appEnvironments, appReleases, db, servers } from "@wfos/db";
import { APP_LIVE_GRACE_SECONDS } from "@wfos/shared";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { deploysQueue } from "../lib/redis";
import { mergeCheckpoint, pendingGrace, servingUnit, slotFlags, sshTarget, type SlotUnit } from "./common";
import { helper, HelperError } from "./helper";
import type { SlotStopJob } from "./jobs";

/** how long the unit that served before a live release keeps running after the switch */
export const GRACE_MS = APP_LIVE_GRACE_SECONDS * 1000;
/** a grace stop this late (its job lost: Redis flushed, a job that died while active) is queued again by the sweep */
export const GRACE_SWEEP_SLACK_MS = 60_000;

/** Queue the grace stop of `slot` (a delayed deploys job: Redis keeps it across a worker restart). */
export async function queueGraceStop(o: Omit<SlotStopJob, "kind">, delayMs: number): Promise<void> {
  // one job per release and unit while it waits (a second add is a no-op); removed when it ends, so the sweep can queue
  // it again after a run that could not reach the server
  await deploysQueue.add(
    "slot_stop",
    { kind: "slot_stop", ...o },
    { delay: Math.max(0, Math.round(delayMs)), jobId: `slot_stop-${o.releaseId}-${o.slot}`, removeOnComplete: true, removeOnFail: true },
  );
}

export type SlotStopResult = "done" | "skipped" | "failed";

/**
 * The grace stop: the unit that served before the release that runs now is stopped (its release folder stays for a
 * later rollback). Skipped when the release that set it up no longer runs (a later release or an instant rollback
 * took over and keeps its own bookkeeping), when the grace was already settled, or when that unit is the one serving.
 * An unreachable server leaves it pending: the sweep queues it again.
 */
export async function runSlotStop(job: SlotStopJob): Promise<SlotStopResult> {
  const [e] = await db.select().from(appEnvironments).where(and(eq(appEnvironments.id, job.environmentId), eq(appEnvironments.workspaceId, job.workspaceId)));
  if (!e || e.kind !== "live") return "skipped";
  if (e.currentReleaseId !== job.releaseId) {
    log.info({ environmentId: e.id, releaseId: job.releaseId, slot: job.slot }, "grace stop skipped: another release runs now");
    return "skipped";
  }
  const [cur] = await db.select().from(appReleases).where(eq(appReleases.id, job.releaseId));
  const g = pendingGrace(cur);
  if (!cur || !g || g.slot !== job.slot) return "skipped";
  if (servingUnit(e, cur) === job.slot) {
    await mergeCheckpoint(cur.id, { graceDone: true });
    return "skipped";
  }
  const [server] = await db.select().from(servers).where(and(eq(servers.id, e.serverId), eq(servers.workspaceId, e.workspaceId)));
  const target = server ? await sshTarget(server) : null;
  if (!target) {
    log.warn({ environmentId: e.id, slot: job.slot }, "grace stop: the server is not usable; tried again later");
    return "failed";
  }
  try {
    await helper(target, "unit-stop", [e.instanceName, ...slotFlags(job.slot)], { timeoutMs: 60_000 });
  } catch (err) {
    if (!(err instanceof HelperError)) {
      // SSH: the server did not answer; the sweep queues it again
      log.warn({ environmentId: e.id, slot: job.slot, err: errorMessage(err) }, "grace stop failed: tried again later");
      return "failed";
    }
    // the helper answered (no such unit, …): nothing left to stop there
    log.warn({ environmentId: e.id, slot: job.slot, err: errorMessage(err) }, "grace stop: the helper refused; settled");
  }
  await mergeCheckpoint(cur.id, { graceDone: true });
  log.info({ environmentId: e.id, slot: job.slot, releaseId: cur.id }, "grace over: the previous unit was stopped");
  return "done";
}

/**
 * Restart-safety net for grace stops (worker start and every apps tick): a live environment whose current release
 * still has a grace unit to stop, past its time (plus slack) or with no job waiting for it, gets the job again.
 * Returns the release ids queued.
 */
export async function sweepGraceStops(now: number = Date.now()): Promise<string[]> {
  const rows = await db
    .select({ env: appEnvironments, rel: appReleases })
    .from(appEnvironments)
    .innerJoin(appReleases, eq(appReleases.id, appEnvironments.currentReleaseId))
    .where(
      and(
        eq(appEnvironments.kind, "live"),
        sql`${appReleases.checkpoint} ->> 'graceSlot' is not null`,
        sql`coalesce((${appReleases.checkpoint} ->> 'graceDone')::boolean, false) = false`,
      ),
    );
  if (!rows.length) return [];
  const waiting = new Map<string, number>();
  for (const j of await deploysQueue.getJobs(["waiting", "delayed", "active", "prioritized"])) {
    if (j?.data?.kind === "slot_stop") waiting.set(`${j.data.releaseId}:${j.data.slot}`, j.timestamp + (j.opts?.delay ?? 0));
  }
  const out: string[] = [];
  for (const { env: e, rel } of rows) {
    const g = pendingGrace(rel);
    if (!g) continue;
    const due = g.until ? Date.parse(g.until) : 0;
    const queuedFor = waiting.get(`${rel.id}:${g.slot}`);
    // a job waits for it, and is not overdue (a delayed job runs on time unless the queue is held or stuck)
    if (queuedFor !== undefined && now < Math.max(due, queuedFor) + GRACE_SWEEP_SLACK_MS) continue;
    try {
      await queueGraceStop({ appId: e.appId, workspaceId: e.workspaceId, environmentId: e.id, releaseId: rel.id, slot: g.slot as SlotUnit }, (Number.isFinite(due) ? due : 0) - now);
      out.push(rel.id);
    } catch (err) {
      log.warn({ err, environmentId: e.id }, "grace stop could not be queued");
    }
  }
  return out;
}
