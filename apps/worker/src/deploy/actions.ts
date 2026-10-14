import { and, asc, eq } from "drizzle-orm";
import { appEnvironments, apps, appReleases, audit, db, servers, users, workspaces } from "@wfos/db";
import { APP_IDLE_STOP_DAYS, appRemoveLockKey, type DeployJob } from "@wfos/shared";
import { env as config } from "../lib/env";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { publish, redis } from "../lib/redis";
import {
  appEnvFile,
  checkLiveDns,
  dnsRefusalMessage,
  envLabel,
  isOwner,
  liveNames,
  recordPublishedNames,
  extraEnv,
  forbiddenEnvKeys,
  forbiddenEnvMessage,
  idleNow,
  notifyApp,
  publishSite,
  runningAppsOn,
  seedRedactor,
  sshTarget,
  unitStatus,
  updateEnvironment,
  waitHealthy,
  type App,
  type Environment,
} from "./common";
import { helper, statusCodeOf } from "./helper";
import { Redactor } from "./log";
import { parseManifest } from "./manifest";
import { appMsg } from "./messages";

type AppActionJob = Extract<DeployJob, { kind: "app_action" }>;
export type AppActionResult = "done" | "refused" | "failed" | "skipped" | null;

/**
 * Stop, start, republish or remove an app environment (the deploys queue runs one job at a time, so an action on an
 * environment whose release is deploying waits for it). The job's environmentId names the environment; without it
 * stop / start / republish act on the preview and remove removes the whole app (every environment, then the app).
 * Never throws for an expected failure: the outcome is the environment's status / statusMessage, an audit entry and
 * app.updated. The web's remove lock (appRemoveLockKey) is cleared when a remove job ends, whatever happened.
 */
export async function runAppAction(job: AppActionJob): Promise<AppActionResult> {
  try {
    return await appAction(job);
  } finally {
    if (job.action === "remove") await redis.del(appRemoveLockKey(job.appId, config.namespace)).catch((e: unknown) => log.warn({ err: e, appId: job.appId }, "remove lock not cleared"));
  }
}

interface ActionCtx {
  job: AppActionJob;
  app: App;
  locale: string | null;
  killSwitch: boolean;
  demoMode: boolean;
  actorLabel: string;
}

async function appAction(job: AppActionJob): Promise<AppActionResult> {
  const [app] = await db.select().from(apps).where(and(eq(apps.id, job.appId), eq(apps.workspaceId, job.workspaceId)));
  if (!app) return null;
  const [ws] = await db.select({ killSwitch: workspaces.killSwitch, demoMode: workspaces.demoMode, locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, job.workspaceId));
  const [who] = job.userId ? await db.select({ email: users.email }).from(users).where(eq(users.id, job.userId)) : [];
  const a: ActionCtx = { job, app, locale: ws?.locale ?? null, killSwitch: !!ws?.killSwitch, demoMode: !!ws?.demoMode, actorLabel: who?.email ?? "system" };

  if (job.action === "remove" && !job.environmentId) return removeApp(a);
  const scope = job.environmentId ? eq(appEnvironments.id, job.environmentId) : eq(appEnvironments.kind, "preview");
  const [envRow] = await db.select().from(appEnvironments).where(and(scope, eq(appEnvironments.appId, app.id), eq(appEnvironments.workspaceId, job.workspaceId)));
  if (!envRow) return null;
  return environmentAction(a, envRow);
}

const record = (a: ActionCtx, e: Pick<Environment, "id" | "kind" | "instanceName"> | null, action: string, details: Record<string, unknown> = {}) =>
  audit({
    workspaceId: a.app.workspaceId,
    actorUserId: a.job.userId,
    actorLabel: a.actorLabel,
    action,
    targetType: "app",
    targetId: a.app.id,
    details: {
      name: a.app.name,
      slug: a.app.slug,
      ...(e ? { environmentId: e.id, environment: e.kind, instance: e.instanceName } : {}),
      ...(a.job.reason ? { reason: a.job.reason } : {}),
      ...details,
    },
  });

/**
 * Remove the whole app: every environment on its server (`app-remove <instance> --drop-db`: unit, site, env, files,
 * user, database), each environment row deleted once its server side is gone (its releases cascade), then the app
 * row. A failure stops there: what was removed stays removed, the rest (and the app) remain for another try.
 */
async function removeApp(a: ActionCtx): Promise<AppActionResult> {
  const envs = await db.select().from(appEnvironments).where(eq(appEnvironments.appId, a.app.id)).orderBy(asc(appEnvironments.createdAt));
  // live first: the client's site goes away before its preview
  envs.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "live" ? -1 : 1));
  const removed: { id: string; kind: string; domain: string; dbDump: string | null }[] = [];
  for (const e of envs) {
    const r = await removeEnvironment(a, e);
    if (r.result !== "done") return r.result;
    removed.push({ id: e.id, kind: e.kind, domain: e.domain, dbDump: r.dbDump });
  }
  await record(a, null, "app.removed", { environments: removed });
  await db.delete(apps).where(eq(apps.id, a.app.id));
  await publish(a.app.workspaceId, { type: "app.updated", appId: a.app.id, status: "stopped" });
  return "done";
}

async function serverOf(e: Environment) {
  const [server] = await db.select().from(servers).where(and(eq(servers.id, e.serverId), eq(servers.workspaceId, e.workspaceId)));
  const target = server ? await sshTarget(server) : null;
  return { server: server ?? null, target };
}

/** where the helper keeps the database dump of a removed LIVE environment (its last stdout line) */
const REMOVED_DUMP_RE = /^\/var\/lib\/wfos-apps\/removed\/[A-Za-z0-9._-]{1,200}\.dump$/;

/**
 * One environment off its server, then its row (releases cascade). A LIVE environment's database is dumped by the
 * helper before it is dropped (`--keep-db-dump`: /var/lib/wfos-apps/removed/<instance>-<UTC stamp>.dump, root 0600,
 * kept 30 days); the path goes into the audit entry and a notification.
 */
async function removeEnvironment(a: ActionCtx, e: Environment): Promise<{ result: AppActionResult; dbDump: string | null }> {
  const { server, target } = await serverOf(e);
  if (!server || !target) {
    log.info({ appId: a.app.id, environmentId: e.id }, "app remove refused: server unavailable");
    await updateEnvironment(e, { statusMessage: "server_unavailable" });
    await record(a, e, "app.remove_refused", { code: "server_unavailable", message: "The environment's server has no usable SSH key or pinned host key" });
    return { result: "refused", dbDump: null };
  }
  const live = e.kind === "live";
  const redactor = new Redactor();
  seedRedactor(e, redactor);
  let dbDump: string | null = null;
  try {
    const r = await helper(target, "app-remove", [e.instanceName, "--drop-db", ...(live ? ["--keep-db-dump"] : [])], { timeoutMs: 600_000 });
    if (live) {
      const last = r.stdout.trim().split("\n").pop()?.trim() ?? "";
      dbDump = REMOVED_DUMP_RE.test(last) ? last : null;
      if (!dbDump) log.warn({ appId: a.app.id, environmentId: e.id }, "live remove: the helper printed no database dump path");
    }
  } catch (err) {
    const error = redactor.apply(errorMessage(err)).slice(0, 500);
    log.warn({ appId: a.app.id, environmentId: e.id, err: error }, "app remove failed");
    await updateEnvironment(e, { statusMessage: statusCodeOf(err) ?? "remove_failed" }).catch(() => null);
    await record(a, e, "app.remove_failed", { error });
    return { result: "failed", dbDump: null };
  }
  await record(a, e, "app.environment_removed", { domain: e.domain, extraDomains: e.extraDomains, ...(live ? { dbDump } : {}) });
  await db.delete(appEnvironments).where(eq(appEnvironments.id, e.id));
  await publish(a.app.workspaceId, { type: "app.updated", appId: a.app.id, status: "stopped", environmentId: e.id });
  if (live) {
    await notifyApp({
      workspaceId: a.app.workspaceId,
      appId: a.app.id,
      userId: a.job.userId,
      kind: "task_done",
      subject: appMsg(a.locale, "app.liveRemoved", { name: a.app.name }),
      text: appMsg(a.locale, dbDump ? "app.liveRemovedText" : "app.liveRemovedNoDumpText", { name: a.app.name, domain: e.domain, server: server.name, path: dbDump ?? "" }),
    });
  }
  return { result: "done", dbDump };
}

async function environmentAction(a: ActionCtx, e: Environment): Promise<AppActionResult> {
  const { job, app } = a;
  const refuse = async (code: string, message: string) => {
    log.info({ appId: app.id, environmentId: e.id, action: job.action, code }, "app action refused");
    await updateEnvironment(e, { statusMessage: code });
    await record(a, e, `app.${job.action}_refused`, { code, message });
    return "refused" as const;
  };

  if (job.action === "remove") return (await removeEnvironment(a, e)).result;

  // the situation may have changed since the job was queued (idleNow is false for a live environment)
  if (job.action === "stop" && job.reason === "idle" && !(await idleNow(e))) {
    log.info({ appId: app.id, environmentId: e.id }, "idle stop skipped: the environment is no longer idle");
    return "skipped";
  }
  if (job.action === "republish" && e.status !== "running") {
    log.info({ appId: app.id, environmentId: e.id, status: e.status }, "republish skipped: not running (the next start publishes it)");
    return "skipped";
  }

  const live = e.kind === "live";
  // LIVE start / republish: the gates of a live release (prepare), before anything is touched
  if (live && (job.action === "start" || job.action === "republish")) {
    if (a.killSwitch) return refuse("kill_switch", "The kill switch is engaged");
    if (a.demoMode) return refuse("dry_run", "Dry run: nothing is changed on LIVE");
    if (!(await isOwner(app.workspaceId, job.userId))) return refuse("owner_required", "Only an Owner of the workspace can start or republish LIVE");
  }

  const { server, target } = await serverOf(e);
  if (!server || !target) return refuse("server_unavailable", "The environment's server has no usable SSH key or pinned host key");
  /** LIVE: the names must point at the server now (a publish may ask for a certificate); the check is stored */
  const liveDnsRefused = async (): Promise<AppActionResult | null> => {
    if (!live) return null;
    const check = await checkLiveDns(e, server);
    if (check.status === "ok") return null;
    return refuse("dns_not_ok", dnsRefusalMessage(check, server.name));
  };
  /** LIVE: the names this publish served, on the release that runs (what a rollback compares them with) */
  const publishedLive = async () => {
    if (live && e.currentReleaseId) await recordPublishedNames(e.currentReleaseId, liveNames(e));
  };
  const redactor = new Redactor();
  seedRedactor(e, redactor);
  let started = false;
  let healthFailed = false;
  try {
    if (job.action === "stop") {
      await helper(target, "unit-stop", [e.instanceName]);
      await helper(target, "unpublish", [e.instanceName]);
      await updateEnvironment(e, { status: "stopped", statusMessage: job.reason === "idle" ? "idle" : null, healthy: null });
      await record(a, e, "app.stopped");
      if (job.reason === "idle") {
        await notifyApp({
          workspaceId: app.workspaceId,
          appId: app.id,
          userId: app.createdBy,
          kind: "task_done",
          subject: appMsg(a.locale, "app.idleStopped", { name: envLabel(app, e) }),
          text: appMsg(a.locale, "app.idleStoppedText", { name: envLabel(app, e), days: APP_IDLE_STOP_DAYS }),
        });
      }
      return "done";
    }

    if (job.action === "republish") {
      const dns = await liveDnsRefused();
      if (dns) return dns;
      // the access mode and password as stored now (publishSite reads them again); no restart
      await publishSite(target, e, redactor);
      await publishedLive();
      await updateEnvironment(e, {});
      await record(a, e, "app.republished", { accessMode: e.accessMode });
      return "done";
    }

    // start
    if (a.killSwitch) return refuse("kill_switch", "The kill switch is engaged");
    const [cur] = e.currentReleaseId ? await db.select().from(appReleases).where(and(eq(appReleases.id, e.currentReleaseId), eq(appReleases.environmentId, e.id))) : [];
    if (!cur?.manifest) return refuse("no_release", "The environment has no deployed version to start");
    if (e.status === "running") return "done";
    // live environments are never held back by previews filling the server's slots
    const others = live ? 0 : await runningAppsOn(server.id, e.id);
    if (!live && others >= server.maxRunningApps) return refuse("server_full", `Server ${server.name} already runs ${others} apps (at most ${server.maxRunningApps})`);
    const m = parseManifest(cur.manifest);
    if (m.database && !server.info?.postgresPort) return refuse("no_database_cluster", `Server ${server.name} reports no apps PostgreSQL cluster`);
    const forbidden = forbiddenEnvKeys(extraEnv(e));
    if (forbidden.length) return refuse("env_forbidden", forbiddenEnvMessage(forbidden));
    const dns = await liveDnsRefused();
    if (dns) return dns;
    // the env as it is now (edits since the last deploy apply), the unit written again for the current release
    // (the helper refuses to start a unit whose binds belong to another release), then start
    await helper(target, "env-install", [e.instanceName], { stdin: await appEnvFile(e, cur.commit, m, redactor, server.info?.postgresPort ?? null) });
    await helper(target, "unit-install", [e.instanceName, e.port, m.memoryMb, ...(m.database ? ["--database"] : [])], { stdin: `${m.start}\n` });
    started = true;
    await helper(target, "unit-start", [e.instanceName]);
    const h = await waitHealthy(target, e, m.health, () => {});
    if (!h.ok) {
      healthFailed = true;
      throw new Error(`no 2xx on ${m.health} (last: ${h.last}; unit ${await unitStatus(target, e.instanceName)})`);
    }
    // access mode changes take effect here
    await publishSite(target, e, redactor);
    await publishedLive();
    await updateEnvironment(e, { status: "running", healthy: true, lastHealthAt: new Date(), statusMessage: null });
    await record(a, e, "app.started", { releaseId: cur.id, commit: cur.commit });
    return "done";
  } catch (err) {
    const error = redactor.apply(errorMessage(err)).slice(0, 500);
    log.warn({ appId: app.id, environmentId: e.id, action: job.action, err: error }, "app action failed");
    const code = statusCodeOf(err);
    if (job.action === "start" && started) {
      // a start that did not finish leaves nothing running (best effort)
      await helper(target, "unit-stop", [e.instanceName]).catch(() => null);
      await updateEnvironment(e, { status: "failed", healthy: false, statusMessage: code ?? (healthFailed ? "health_failed" : "start_failed") }).catch(() => null);
    } else {
      await updateEnvironment(e, { statusMessage: code ?? `${job.action}_failed` }).catch(() => null);
    }
    await record(a, e, `app.${job.action}_failed`, { error });
    return "failed";
  }
}
