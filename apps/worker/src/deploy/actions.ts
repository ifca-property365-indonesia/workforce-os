import { and, eq } from "drizzle-orm";
import { apps, appReleases, audit, db, servers, users, workspaces } from "@wfos/db";
import { APP_IDLE_STOP_DAYS, appRemoveLockKey, type DeployJob } from "@wfos/shared";
import { env } from "../lib/env";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { publish, redis } from "../lib/redis";
import { appEnvFile, extraEnv, forbiddenEnvKeys, forbiddenEnvMessage, idleNow, notifyApp, publishSite, runningAppsOn, seedRedactor, sshTarget, unitStatus, updateApp, waitHealthy } from "./common";
import { helper, statusCodeOf } from "./helper";
import { Redactor } from "./log";
import { parseManifest } from "./manifest";
import { appMsg } from "./messages";

type AppActionJob = Extract<DeployJob, { kind: "app_action" }>;
export type AppActionResult = "done" | "refused" | "failed" | "skipped" | null;

/**
 * Stop, start, republish or remove an app (the deploys queue runs one job at a time, so an action on an app whose
 * release is deploying waits for it). Never throws for an expected failure: the outcome is the app's status /
 * statusMessage, an audit entry and app.updated. The web's remove lock (appRemoveLockKey) is cleared when a remove
 * job ends, whatever happened.
 */
export async function runAppAction(job: AppActionJob): Promise<AppActionResult> {
  try {
    return await appAction(job);
  } finally {
    if (job.action === "remove") await redis.del(appRemoveLockKey(job.appId, env.namespace)).catch((e: unknown) => log.warn({ err: e, appId: job.appId }, "remove lock not cleared"));
  }
}

async function appAction(job: AppActionJob): Promise<AppActionResult> {
  const [app] = await db.select().from(apps).where(and(eq(apps.id, job.appId), eq(apps.workspaceId, job.workspaceId)));
  if (!app) return null;
  const [server] = await db.select().from(servers).where(and(eq(servers.id, app.serverId), eq(servers.workspaceId, job.workspaceId)));
  const [ws] = await db.select({ killSwitch: workspaces.killSwitch, locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, job.workspaceId));
  const [who] = job.userId ? await db.select({ email: users.email }).from(users).where(eq(users.id, job.userId)) : [];
  const record = (action: string, details: Record<string, unknown> = {}) =>
    audit({
      workspaceId: app.workspaceId,
      actorUserId: job.userId,
      actorLabel: who?.email ?? "system",
      action,
      targetType: "app",
      targetId: app.id,
      details: { name: app.name, slug: app.slug, ...(job.reason ? { reason: job.reason } : {}), ...details },
    });
  const refuse = async (code: string, message: string) => {
    log.info({ appId: app.id, action: job.action, code }, "app action refused");
    await updateApp(app, { statusMessage: code });
    await record(`app.${job.action}_refused`, { code, message });
    return "refused" as const;
  };

  // the situation may have changed since the job was queued
  if (job.action === "stop" && job.reason === "idle" && !(await idleNow(app))) {
    log.info({ appId: app.id }, "idle stop skipped: the app is no longer idle");
    return "skipped";
  }
  if (job.action === "republish" && app.status !== "running") {
    log.info({ appId: app.id, status: app.status }, "republish skipped: the app is not running (the next start publishes it)");
    return "skipped";
  }

  const target = server ? await sshTarget(server) : null;
  if (!server || !target) return refuse("server_unavailable", "The app's server has no usable SSH key or pinned host key");
  const redactor = new Redactor();
  seedRedactor(app, redactor);
  let started = false;
  let healthFailed = false;
  try {
    if (job.action === "stop") {
      await helper(target, "unit-stop", [app.slug]);
      await helper(target, "unpublish", [app.slug]);
      await updateApp(app, { status: "stopped", statusMessage: job.reason === "idle" ? "idle" : null, healthy: null });
      await record("app.stopped");
      if (job.reason === "idle") {
        await notifyApp({
          workspaceId: app.workspaceId,
          appId: app.id,
          userId: app.createdBy,
          kind: "task_done",
          subject: appMsg(ws?.locale, "app.idleStopped", { name: app.name }),
          text: appMsg(ws?.locale, "app.idleStoppedText", { name: app.name, days: APP_IDLE_STOP_DAYS }),
        });
      }
      return "done";
    }

    if (job.action === "republish") {
      // the access mode and preview password as stored now (publishSite reads them again); no restart
      await publishSite(target, app, redactor);
      await updateApp(app, {});
      await record("app.republished", { accessMode: app.accessMode });
      return "done";
    }

    if (job.action === "start") {
      if (ws?.killSwitch) return refuse("kill_switch", "The kill switch is engaged");
      const [cur] = app.currentReleaseId ? await db.select().from(appReleases).where(eq(appReleases.id, app.currentReleaseId)) : [];
      if (!cur?.manifest) return refuse("no_release", "The app has no deployed version to start");
      if (app.status === "running") return "done";
      const others = await runningAppsOn(server.id, app.id);
      if (others >= server.maxRunningApps) return refuse("server_full", `Server ${server.name} already runs ${others} apps (at most ${server.maxRunningApps})`);
      const m = parseManifest(cur.manifest);
      if (m.database && !server.info?.postgresPort) return refuse("no_database_cluster", `Server ${server.name} reports no apps PostgreSQL cluster`);
      const forbidden = forbiddenEnvKeys(extraEnv(app));
      if (forbidden.length) return refuse("env_forbidden", forbiddenEnvMessage(forbidden));
      // the env as it is now (edits since the last deploy apply), the unit written again for the current release
      // (the helper refuses to start a unit whose binds belong to another release), then start
      await helper(target, "env-install", [app.slug], { stdin: await appEnvFile(app, cur.commit, m, redactor, server.info?.postgresPort ?? null) });
      await helper(target, "unit-install", [app.slug, app.port, m.memoryMb, ...(m.database ? ["--database"] : [])], { stdin: `${m.start}\n` });
      started = true;
      await helper(target, "unit-start", [app.slug]);
      const h = await waitHealthy(target, app, m.health, () => {});
      if (!h.ok) {
        healthFailed = true;
        throw new Error(`no 2xx on ${m.health} (last: ${h.last}; unit ${await unitStatus(target, app.slug)})`);
      }
      // access mode changes take effect here
      await publishSite(target, app, redactor);
      await updateApp(app, { status: "running", healthy: true, lastHealthAt: new Date(), statusMessage: null });
      await record("app.started", { releaseId: cur.id, commit: cur.commit });
      return "done";
    }

    // remove: everything on the server (unit, site, env, files, user, database), then the row (releases cascade)
    await helper(target, "app-remove", [app.slug, "--drop-db"], { timeoutMs: 300_000 });
    await record("app.removed", { domain: app.domain });
    await db.delete(apps).where(eq(apps.id, app.id));
    await publish(app.workspaceId, { type: "app.updated", appId: app.id, status: "stopped" });
    return "done";
  } catch (e) {
    const error = redactor.apply(errorMessage(e)).slice(0, 500);
    log.warn({ appId: app.id, action: job.action, err: error }, "app action failed");
    const code = statusCodeOf(e);
    if (job.action === "start" && started) {
      // a start that did not finish leaves nothing running (best effort)
      await helper(target, "unit-stop", [app.slug]).catch(() => null);
      await updateApp(app, { status: "failed", healthy: false, statusMessage: code ?? (healthFailed ? "health_failed" : "start_failed") }).catch(() => null);
    } else {
      await updateApp(app, { statusMessage: code ?? `${job.action}_failed` }).catch(() => null);
    }
    await record(`app.${job.action}_failed`, { error });
    return "failed";
  }
}
