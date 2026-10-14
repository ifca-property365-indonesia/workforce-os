import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { appEnvironments, apps, appReleases, db, servers, workspaces } from "@wfos/db";
import { APP_IDLE_STOP_DAYS } from "@wfos/shared";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { deploysQueue, redis } from "../lib/redis";
import { queueDailyBackups } from "../deploy/backups";
import { envLabel, idleNow, notifyApp, publishEnvironment, servingUnit, slotPort, sshTarget } from "../deploy/common";
import { sweepGraceStops } from "../deploy/slots";
import { helperCall } from "../deploy/helper";
import { parseManifest } from "../deploy/manifest";
import { appMsg } from "../deploy/messages";

/** How often index.ts looks for environments due a health check or an idle stop. */
export const APPS_TICK_MS = 10 * 60_000;
/** A running environment's health is checked again when its last check is at least this old (hourly). */
export const APP_HEALTH_EVERY_MS = 60 * 60_000;
const IDLE_MS = APP_IDLE_STOP_DAYS * 24 * 60 * 60_000;
const HEALTH_BATCH = 50;

export interface AppsTickOutcome {
  /** environments (always previews) an idle stop was queued for */
  idle: string[];
  /** environments whose health was checked, and the result */
  health: { appId: string; environmentId: string; healthy: boolean; wentDown: boolean }[];
  /** live environments a daily database backup was queued for */
  backups: string[];
  /** releases whose lost live grace stop was queued again */
  graceStops: string[];
}

/**
 * Running PREVIEWS with no new release for APP_IDLE_STOP_DAYS (and not started again by a person within that time)
 * get a `stop` job with reason idle; the stop itself notifies. A live environment is never stopped for being idle.
 * A day-long Redis claim keeps one tick from queueing it twice.
 */
async function queueIdleStops(now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - IDLE_MS);
  const candidates = await db
    .select({
      id: appEnvironments.id,
      appId: appEnvironments.appId,
      workspaceId: appEnvironments.workspaceId,
      kind: appEnvironments.kind,
      status: appEnvironments.status,
      lastDeployedAt: appEnvironments.lastDeployedAt,
    })
    .from(appEnvironments)
    .where(and(eq(appEnvironments.kind, "preview"), eq(appEnvironments.status, "running"), lte(appEnvironments.lastDeployedAt, cutoff)));
  const out: string[] = [];
  for (const e of candidates) {
    if (!(await idleNow(e, now))) continue;
    if ((await redis.set(`${env.namespace}:app-idle-stop:${e.id}`, "1", "PX", 24 * 60 * 60_000, "NX")) === null) continue;
    await deploysQueue.add(
      "app_action",
      { kind: "app_action", appId: e.appId, workspaceId: e.workspaceId, environmentId: e.id, action: "stop", userId: null, reason: "idle" },
      { jobId: `app-${e.appId}-${e.id}-stop-${now.getTime()}` },
    );
    out.push(e.id);
  }
  return out;
}

/**
 * Health of each running environment (preview and live) on a ready server whose last check is APP_HEALTH_EVERY_MS
 * old: `health` through the helper (the environment's instance and port, its current manifest's path). healthy →
 * unhealthy notifies once (the conditional update decides who sends it); every change publishes app.updated. An SSH
 * failure says nothing about the app (the server check reports it) and is skipped.
 */
async function checkHealth(now: Date, skip: Set<string>): Promise<AppsTickOutcome["health"]> {
  const due = await db
    .select({ env: appEnvironments, appName: apps.name, server: servers, manifest: appReleases.manifest, checkpoint: appReleases.checkpoint, locale: workspaces.defaultLocale })
    .from(appEnvironments)
    .innerJoin(apps, eq(apps.id, appEnvironments.appId))
    .innerJoin(servers, eq(servers.id, appEnvironments.serverId))
    .innerJoin(appReleases, eq(appReleases.id, appEnvironments.currentReleaseId))
    .innerJoin(workspaces, eq(workspaces.id, appEnvironments.workspaceId))
    .where(
      and(
        eq(appEnvironments.status, "running"),
        eq(servers.status, "ready"),
        or(isNull(appEnvironments.lastHealthAt), lte(appEnvironments.lastHealthAt, new Date(now.getTime() - APP_HEALTH_EVERY_MS))),
      ),
    )
    .orderBy(sql`${appEnvironments.lastHealthAt} asc nulls first`)
    .limit(HEALTH_BATCH);
  const out: AppsTickOutcome["health"] = [];
  for (const { env: e, appName, server, manifest, checkpoint, locale } of due) {
    if (skip.has(e.id)) continue;
    // behind the maintenance page (a breaking migration, a restore) the app is down on purpose
    if (e.maintenance || e.statusMessage === "restoring") continue;
    try {
      const target = await sshTarget(server);
      if (!target) continue;
      const path = parseManifest(manifest).health;
      let r;
      try {
        // live: the port of the unit that serves (a slot, or the B1 single unit)
        const port = e.kind === "live" ? slotPort(e, servingUnit(e, { checkpoint })) : e.port;
        r = await helperCall(target, "health", [e.instanceName, port, path], { timeoutMs: 30_000 });
      } catch (err) {
        log.warn({ appId: e.appId, environmentId: e.id, err: (err as Error).message }, "app health check: server not reachable");
        continue;
      }
      const healthy = r.code === 0;
      const status = (() => {
        try {
          return String((JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { status?: unknown }).status ?? "?");
        } catch {
          return "?";
        }
      })();
      // only while it still runs (a stop or deploy in the meantime wins); going down is claimed by the row moving
      // from healthy (or unknown) to unhealthy, so one tick sends the notification
      const running = and(eq(appEnvironments.id, e.id), eq(appEnvironments.status, "running"));
      const [down] = healthy
        ? []
        : await db
            .update(appEnvironments)
            .set({ healthy: false, lastHealthAt: now })
            .where(and(running, or(isNull(appEnvironments.healthy), eq(appEnvironments.healthy, true))))
            .returning({ id: appEnvironments.id });
      const wentDown = !!down;
      if (!wentDown) {
        const [row] = await db.update(appEnvironments).set({ healthy, lastHealthAt: now }).where(running).returning({ id: appEnvironments.id });
        if (!row) continue;
      }
      // a LIVE site the uptime check already reported down: its Owners heard it, no second alarm
      if (wentDown && !(e.kind === "live" && e.uptimeStatus === "down")) {
        const name = envLabel({ name: appName }, e);
        await notifyApp({
          workspaceId: e.workspaceId,
          appId: e.appId,
          userId: null,
          kind: "incident",
          subject: appMsg(locale, "app.unhealthy", { name }),
          text: appMsg(locale, "app.unhealthyText", { name, detail: `${path} → HTTP ${status}` }),
        });
      }
      if (e.healthy !== healthy) await publishEnvironment({ ...e, status: "running" });
      out.push({ appId: e.appId, environmentId: e.id, healthy, wentDown });
    } catch (err) {
      log.warn({ err, appId: e.appId, environmentId: e.id }, "app health check failed");
    }
  }
  return out;
}

/** Called every APPS_TICK_MS by index.ts: idle stops, health, daily live backups, lost grace stops. */
export async function tickApps(now: Date = new Date()): Promise<AppsTickOutcome> {
  const idle = await queueIdleStops(now);
  const health = await checkHealth(now, new Set(idle));
  const backups = await queueDailyBackups(now).catch((e: unknown) => {
    log.warn({ err: e }, "daily backups could not be queued");
    return [] as string[];
  });
  const graceStops = await sweepGraceStops(now.getTime()).catch((e: unknown) => {
    log.warn({ err: e }, "grace stops could not be swept");
    return [] as string[];
  });
  return { idle, health, backups, graceStops };
}
