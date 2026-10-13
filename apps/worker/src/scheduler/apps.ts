import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { apps, appReleases, db, servers, workspaces } from "@wfos/db";
import { APP_IDLE_STOP_DAYS } from "@wfos/shared";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { deploysQueue, publish, redis } from "../lib/redis";
import { idleNow, notifyApp, sshTarget } from "../deploy/common";
import { helperCall } from "../deploy/helper";
import { parseManifest } from "../deploy/manifest";
import { appMsg } from "../deploy/messages";

/** How often index.ts looks for apps due a health check or an idle stop. */
export const APPS_TICK_MS = 10 * 60_000;
/** A running app's health is checked again when its last check is at least this old (hourly). */
export const APP_HEALTH_EVERY_MS = 60 * 60_000;
const IDLE_MS = APP_IDLE_STOP_DAYS * 24 * 60 * 60_000;
const HEALTH_BATCH = 50;

export interface AppsTickOutcome {
  /** apps an idle stop was queued for */
  idle: string[];
  /** apps whose health was checked, and the result */
  health: { appId: string; healthy: boolean; wentDown: boolean }[];
}

/**
 * Running apps with no new release for APP_IDLE_STOP_DAYS (and not started again by a person within that time) get a
 * `stop` job with reason idle; the stop itself notifies. A day-long Redis claim keeps one tick from queueing it twice.
 */
async function queueIdleStops(now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - IDLE_MS);
  const candidates = await db
    .select({ id: apps.id, workspaceId: apps.workspaceId, status: apps.status, lastDeployedAt: apps.lastDeployedAt })
    .from(apps)
    .where(and(eq(apps.status, "running"), lte(apps.lastDeployedAt, cutoff)));
  const out: string[] = [];
  for (const a of candidates) {
    if (!(await idleNow(a, now))) continue;
    if ((await redis.set(`${env.namespace}:app-idle-stop:${a.id}`, "1", "PX", 24 * 60 * 60_000, "NX")) === null) continue;
    await deploysQueue.add(
      "app_action",
      { kind: "app_action", appId: a.id, workspaceId: a.workspaceId, action: "stop", userId: null, reason: "idle" },
      { jobId: `app-${a.id}-stop-${now.getTime()}` },
    );
    out.push(a.id);
  }
  return out;
}

/**
 * Health of each running app on a ready server whose last check is APP_HEALTH_EVERY_MS old: `health` through the
 * helper (the app's own port, its manifest's path). healthy → unhealthy notifies once (the conditional update
 * decides who sends it); every change publishes app.updated. An SSH failure says nothing about the app (the server
 * check reports it) and is skipped.
 */
async function checkHealth(now: Date, skip: Set<string>): Promise<AppsTickOutcome["health"]> {
  const due = await db
    .select({ app: apps, server: servers, manifest: appReleases.manifest, locale: workspaces.defaultLocale })
    .from(apps)
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .innerJoin(appReleases, eq(appReleases.id, apps.currentReleaseId))
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.status, "running"), eq(servers.status, "ready"), or(isNull(apps.lastHealthAt), lte(apps.lastHealthAt, new Date(now.getTime() - APP_HEALTH_EVERY_MS)))))
    .orderBy(sql`${apps.lastHealthAt} asc nulls first`)
    .limit(HEALTH_BATCH);
  const out: AppsTickOutcome["health"] = [];
  for (const { app, server, manifest, locale } of due) {
    if (skip.has(app.id)) continue;
    try {
      const target = await sshTarget(server);
      if (!target) continue;
      const path = parseManifest(manifest).health;
      let r;
      try {
        r = await helperCall(target, "health", [app.slug, app.port, path], { timeoutMs: 30_000 });
      } catch (e) {
        log.warn({ appId: app.id, err: (e as Error).message }, "app health check: server not reachable");
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
      const running = and(eq(apps.id, app.id), eq(apps.status, "running"));
      const [down] = healthy
        ? []
        : await db
            .update(apps)
            .set({ healthy: false, lastHealthAt: now })
            .where(and(running, or(isNull(apps.healthy), eq(apps.healthy, true))))
            .returning({ id: apps.id });
      const wentDown = !!down;
      if (!wentDown) {
        const [row] = await db.update(apps).set({ healthy, lastHealthAt: now }).where(running).returning({ id: apps.id });
        if (!row) continue;
      }
      if (wentDown) {
        await notifyApp({
          workspaceId: app.workspaceId,
          appId: app.id,
          userId: null,
          kind: "incident",
          subject: appMsg(locale, "app.unhealthy", { name: app.name }),
          text: appMsg(locale, "app.unhealthyText", { name: app.name, detail: `${path} → HTTP ${status}` }),
        });
      }
      if (app.healthy !== healthy) await publish(app.workspaceId, { type: "app.updated", appId: app.id, status: "running" });
      out.push({ appId: app.id, healthy, wentDown });
    } catch (e) {
      log.warn({ err: e, appId: app.id }, "app health check failed");
    }
  }
  return out;
}

/** Called every APPS_TICK_MS by index.ts. */
export async function tickApps(now: Date = new Date()): Promise<AppsTickOutcome> {
  const idle = await queueIdleStops(now);
  const health = await checkHealth(now, new Set(idle));
  return { idle, health };
}
