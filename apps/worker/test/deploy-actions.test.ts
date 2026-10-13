import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apps, appReleases, audit, auditLog, db } from "@wfos/db";
import type { DeployJob, NotifyJob } from "@wfos/shared";
import { runAppAction } from "../src/deploy/actions";
import { DelayedError } from "bullmq";
import { utimesSync, writeFileSync, rmSync } from "node:fs";
import { activeDeployCount, DEPLOY_HOLD_DELAY_MS, onDeployActivity, processDeployJob, recoverInterruptedReleases } from "../src/deploy";
import { isLinkLocal } from "../src/deploy/common";
import { helperCode } from "../src/deploy/helper";
import { appRemoveLockKey } from "@wfos/shared";
import bcrypt from "bcryptjs";
import { encryptSecret } from "@wfos/shared/server";
import { env } from "../src/lib/env";
import { runRelease } from "../src/deploy/pipeline";
import { Redactor, ReleaseLog, RELEASE_LOG_MAX } from "../src/deploy/log";
import { DESTRUCTIVE_SQL_RE, destructiveMigrationLines } from "../src/deploy/manifest";
import { deploysQueue, redis } from "../src/lib/redis";
import { tickApps, APP_HEALTH_EVERY_MS } from "../src/scheduler/apps";
import { heartbeat } from "../src/lib/heartbeat";
import { FakeServer, fastDeploys, makeApp, makeRemote, queueRelease, SECRET_ENV } from "./deploy-fixtures";
import { resetTransport, transport } from "./transport";

vi.mock("@wfos/shared/ssh", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/ssh")>();
  return { ...real, sshExec: vi.fn(), sftpPut: vi.fn() };
});

let srv: FakeServer;
beforeEach(() => {
  resetTransport();
  srv = new FakeServer();
  srv.install();
  fastDeploys();
});

const appRow = async (id: string) => (await db.select().from(apps).where(eq(apps.id, id)))[0];
const releaseRow = async (id: string) => (await db.select().from(appReleases).where(eq(appReleases.id, id)))[0]!;
const actions = async (appId: string) => (await db.select().from(auditLog).where(eq(auditLog.targetId, appId))).map((a) => a.action);
const notifications = (workspaceId: string) => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob).filter((n) => n.workspaceId === workspaceId);
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60_000);

/** An app with one deployed release, running on the fake server. */
async function runningApp(over: Parameters<typeof makeApp>[0]["server"] = {}) {
  const repo = makeRemote();
  const f = await makeApp({ remote: repo.remote, server: over });
  const rel = await queueRelease(f.app, { createdBy: f.user.id });
  const status = await runRelease(rel.id, f.ws.id);
  if (status !== "deployed") throw new Error(`setup deploy ${status}: ${(await releaseRow(rel.id)).error}`);
  srv.calls.length = 0;
  resetTransport();
  return { ...f, repo, rel, app: (await appRow(f.app.id))! };
}
const job = (app: { id: string; workspaceId: string }, action: "stop" | "start" | "remove" | "republish", over: Partial<Extract<DeployJob, { kind: "app_action" }>> = {}) =>
  ({ kind: "app_action", appId: app.id, workspaceId: app.workspaceId, action, userId: null, ...over }) as Extract<DeployJob, { kind: "app_action" }>;

describe("app actions", () => {
  it("stop: unit stopped and site unpublished, status stopped, audited", async () => {
    const { app, user } = await runningApp();
    expect(await runAppAction(job(app, "stop", { userId: user.id }))).toBe("done");
    expect(srv.sequence()).toEqual(["unit-stop", "unpublish"]);
    expect(await appRow(app.id)).toMatchObject({ status: "stopped", statusMessage: null, healthy: null });
    expect(await actions(app.id)).toContain("app.stopped");
    expect(transport.published.map((p) => p.ev)).toContainEqual({ type: "app.updated", appId: app.id, status: "stopped" });
  });

  it("idle stop: statusMessage idle and a notification", async () => {
    const { app, ws } = await runningApp();
    await db.update(apps).set({ lastDeployedAt: daysAgo(15) }).where(eq(apps.id, app.id));
    expect(await runAppAction(job(app, "stop", { reason: "idle" }))).toBe("done");
    expect(await appRow(app.id)).toMatchObject({ status: "stopped", statusMessage: "idle" });
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ notificationKind: "task_done", subject: expect.stringContaining("stopped") })]);
  });

  it("start: env, unit, health, site; status running; audited app.started", async () => {
    const { app } = await runningApp();
    await runAppAction(job(app, "stop"));
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "start"))).toBe("done");
    expect(srv.sequence()).toEqual(["env-install", "unit-install", "unit-start", "health", "publish"]);
    // the unit is written again for the current release before it starts (its binds must match)
    expect(srv.callsOf("unit-install")[0]).toMatchObject({ args: [app.slug, String(app.port), "512", "--database"], stdin: "pnpm start -H 127.0.0.1 -p $PORT\n" });
    expect(srv.callsOf("publish")[0]!.args).toEqual([app.slug, String(app.port), "--auth"]);
    expect(srv.env).toContain(`SMTP_PASSWORD=${SECRET_ENV}`);
    expect(await appRow(app.id)).toMatchObject({ status: "running", healthy: true, statusMessage: null });
    expect(await actions(app.id)).toContain("app.started");
  });

  it("start is refused when the server is at maxRunningApps, or without a deployed version", async () => {
    const { app, ws, server } = await runningApp({ maxRunningApps: 1 });
    await runAppAction(job(app, "stop"));
    await db.insert(apps).values({ workspaceId: ws.id, serverId: server.id, name: "other", slug: `o-${app.slug}`.slice(0, 30), domain: `o-${app.domain}`, port: app.port + 1000, status: "running" });
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "start"))).toBe("refused");
    expect(srv.calls).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ status: "stopped", statusMessage: "server_full" });
    expect(await actions(app.id)).toContain("app.start_refused");

    const fresh = await makeApp({ remote: makeRemote().remote });
    expect(await runAppAction(job(fresh.app, "start"))).toBe("refused");
    expect(await appRow(fresh.app.id)).toMatchObject({ status: "new", statusMessage: "no_release" });
  });

  it("start failing its health check: stopped again, status failed", async () => {
    const { app } = await runningApp();
    await runAppAction(job(app, "stop"));
    srv.healthy = () => false;
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "start"))).toBe("failed");
    expect(srv.sequence()).toEqual(["env-install", "unit-install", "unit-start", "health", "unit-status", "unit-stop"]);
    expect(await appRow(app.id)).toMatchObject({ status: "failed", statusMessage: "health_failed" });
  });

  it("remove: app-remove --drop-db, then the row and its releases are gone", async () => {
    const { app, rel } = await runningApp();
    expect(await runAppAction(job(app, "remove"))).toBe("done");
    expect(srv.calls.map((c) => [c.cmd, ...c.args])).toEqual([["app-remove", app.slug, "--drop-db"]]);
    expect(await appRow(app.id)).toBeUndefined();
    expect(await db.select().from(appReleases).where(eq(appReleases.id, rel.id))).toEqual([]);
    expect(await actions(app.id)).toContain("app.removed");
  });

  it("a failed action keeps the app and records why (redacted)", async () => {
    const { app } = await runningApp();
    srv.replies["app-remove"] = { code: 1, stderr: "rm: cannot remove\n" };
    expect(await runAppAction(job(app, "remove"))).toBe("failed");
    expect(await appRow(app.id)).toMatchObject({ statusMessage: "remove_failed" });
    expect(await actions(app.id)).toContain("app.remove_failed");
  });

  it("the deploys processor counts the running job for the heartbeat (activeDeploys)", async () => {
    const { app } = await runningApp();
    let during = -1;
    srv.replies["unit-stop"] = () => {
      during = activeDeployCount();
      return { code: 0 };
    };
    expect(activeDeployCount()).toBe(0);
    await processDeployJob({ data: job(app, "stop") } as Parameters<typeof processDeployJob>[0]);
    expect(during).toBe(1);
    expect(activeDeployCount()).toBe(0);
    expect((await heartbeat()).activeDeploys).toBe(0);
  });
});

describe("review fixes: actions", () => {
  it("republish on a running app: publish with the stored preview login, audited, no restart", async () => {
    const { app } = await runningApp();
    // the Admin rotated the password
    await db.update(apps).set({ accessPasswordEnc: encryptSecret("NewPassw0rdXyzAb") }).where(eq(apps.id, app.id));
    expect(await runAppAction(job(app, "republish"))).toBe("done");
    expect(srv.sequence()).toEqual(["publish"]);
    const line = srv.callsOf("publish")[0]!.stdin!.trim();
    expect(await bcrypt.compare("NewPassw0rdXyzAb", line.split(":")[1]!)).toBe(true);
    expect(await actions(app.id)).toContain("app.republished");
    expect(transport.published.map((p) => p.ev)).toContainEqual({ type: "app.updated", appId: app.id, status: "running" });
  });

  it("republish after switching to public: no --auth; on a stopped app: nothing happens", async () => {
    const { app } = await runningApp();
    await db.update(apps).set({ accessMode: "public" }).where(eq(apps.id, app.id));
    expect(await runAppAction(job(app, "republish"))).toBe("done");
    expect(srv.callsOf("publish")[0]!.args).toEqual([app.slug, String(app.port)]);
    await runAppAction(job(app, "stop"));
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "republish"))).toBe("skipped");
    expect(srv.calls).toEqual([]);
  });

  it("an idle stop that is no longer due when it runs is skipped", async () => {
    const { app } = await runningApp(); // just deployed
    expect(await runAppAction(job(app, "stop", { reason: "idle" }))).toBe("skipped");
    expect(srv.calls).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ status: "running" });
  });

  it("a start that fails after unit-start stops the unit again (best effort): status failed, start_failed", async () => {
    const { app } = await runningApp();
    await runAppAction(job(app, "stop"));
    srv.calls.length = 0;
    srv.replies["publish"] = { code: 3, stderr: "wfos-app-helper: cert_limit: 10 new certificates today\n" };
    expect(await runAppAction(job(app, "start"))).toBe("failed");
    expect(srv.sequence()).toEqual(["env-install", "unit-install", "unit-start", "health", "publish", "unit-stop"]);
    expect(await appRow(app.id)).toMatchObject({ status: "failed", statusMessage: "start_failed" });
    expect(srv.env).toContain("@localhost:5433/");
  });

  it("the web's remove lock is cleared when the remove job ends, also when it fails", async () => {
    const { app } = await runningApp();
    const key = appRemoveLockKey(app.id, env.namespace);
    await redis.set(key, "u", "PX", 600_000, "NX");
    srv.replies["app-remove"] = { code: 1, stderr: "boom\n" };
    expect(await runAppAction(job(app, "remove"))).toBe("failed");
    expect(await (redis as unknown as { get: (k: string) => Promise<string | null> }).get(key)).toBeNull();
    delete srv.replies["app-remove"];
    await redis.set(key, "u", "PX", 600_000, "NX");
    expect(await runAppAction(job(app, "remove"))).toBe("done");
    expect(await (redis as unknown as { get: (k: string) => Promise<string | null> }).get(key)).toBeNull();
  });

  it("the heartbeat is written when a deploy job starts and when it ends", async () => {
    const { app } = await runningApp();
    const seen: number[] = [];
    onDeployActivity(async () => void seen.push(activeDeployCount()));
    try {
      await processDeployJob({ data: job(app, "stop") } as Parameters<typeof processDeployJob>[0]);
    } finally {
      onDeployActivity(async () => {});
    }
    expect(seen).toEqual([1, 0]);
  });
});

describe("helper refusals that become the app's statusMessage", () => {
  it("start refused by the helper with server_full / firewall_off: statusMessage is the code", async () => {
    const { app } = await runningApp();
    await runAppAction(job(app, "stop"));
    srv.replies["unit-start"] = { code: 3, stderr: "wfos-app-helper: server_full: 3 apps already run on this server (at most 3)\n" };
    expect(await runAppAction(job(app, "start"))).toBe("failed");
    expect(await appRow(app.id)).toMatchObject({ status: "failed", statusMessage: "server_full" });
    srv.replies["unit-start"] = { code: 3, stderr: "wfos-app-helper: firewall_off: the app firewall (nftables table inet wfos_apps) is not loaded\n" };
    await db.update(apps).set({ status: "stopped" }).where(eq(apps.id, app.id));
    expect(await runAppAction(job(app, "start"))).toBe("failed");
    expect(await appRow(app.id)).toMatchObject({ statusMessage: "firewall_off" });
    expect((await db.select().from(auditLog).where(eq(auditLog.targetId, app.id))).at(-1)!.details).toMatchObject({ error: expect.stringMatching(/re-run prepare\.sh/) });
  });

  it("a person-set env name the platform owns (PATH, LD_*, COREPACK_*…) refuses start before anything runs", async () => {
    const { app } = await runningApp();
    await runAppAction(job(app, "stop"));
    await db.update(apps).set({ envEnc: encryptSecret(JSON.stringify({ LD_PRELOAD: "/x.so", OK: "1" })) }).where(eq(apps.id, app.id));
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "start"))).toBe("refused");
    expect(srv.calls).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ statusMessage: "env_forbidden" });
  });
});

describe("review fixes: helper and network details", () => {
  it("reads the helper's reason code from `wfos-app-helper: <code>: <detail>`", () => {
    expect(helperCode("wfos-app-helper: release_active: releases/x is the running release\n")).toBe("release_active");
    expect(helperCode("noise\nwfos-app-helper: server_name_taken: another nginx site\n")).toBe("server_name_taken");
    expect(helperCode("wfos-app-helper: backup_missing: no backup x for y")).toBe("backup_missing");
    expect(helperCode("wfos-app-helper: pg_dump of app_x failed")).toBeNull();
    expect(helperCode("disk_low somewhere in a build log")).toBeNull();
  });

  it("the public check never dials link-local / metadata addresses, even where private servers are allowed", () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "fe80::1"]) expect(isLinkLocal(ip)).toBe(true);
    for (const ip of ["10.0.0.1", "127.0.0.1", "43.165.198.163", "2001:db8::1"]) expect(isLinkLocal(ip)).toBe(false);
  });
});

describe("upgrade hold", () => {
  it("while deploy/upgrade.sh holds deploys the job is delayed (not run, not active); a stale hold file is ignored", async () => {
    const { app } = await runningApp();
    const moveToDelayed = vi.fn(async () => {});
    const fakeJob = { id: "j1", data: job(app, "stop"), moveToDelayed } as unknown as Parameters<typeof processDeployJob>[0];
    writeFileSync(env.deploysHoldFile, "upgrade 1\n");
    try {
      let during = -1;
      moveToDelayed.mockImplementation(async () => void (during = activeDeployCount()));
      const t0 = Date.now();
      await expect(processDeployJob(fakeJob, "tok")).rejects.toBeInstanceOf(DelayedError);
      expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "tok");
      const until = (moveToDelayed.mock.calls[0] as unknown as [number])[0];
      expect(until - t0).toBeGreaterThanOrEqual(DEPLOY_HOLD_DELAY_MS - 50);
      expect(during).toBe(0);
      expect(srv.calls).toEqual([]);
      expect(await appRow(app.id)).toMatchObject({ status: "running" });

      // left over from an upgrade that died more than 2 h ago: ignored, the job runs
      const old = new Date(Date.now() - 3 * 60 * 60_000);
      utimesSync(env.deploysHoldFile, old, old);
      moveToDelayed.mockClear();
      await processDeployJob(fakeJob, "tok");
      expect(moveToDelayed).not.toHaveBeenCalled();
      expect(await appRow(app.id)).toMatchObject({ status: "stopped" });
    } finally {
      rmSync(env.deploysHoldFile, { force: true });
    }
  });

  it("the hold file is <STORAGE_DIR>/deploys.hold, as upgrade.sh computes it", () => {
    expect(env.deploysHoldFile).toBe(`${process.env.STORAGE_DIR}/deploys.hold`);
  });
});

describe("apps scheduler", () => {
  it("queues an idle stop for a running app without a release for APP_IDLE_STOP_DAYS, once", async () => {
    const { app } = await runningApp();
    const { app: recent } = await runningApp();
    await db.update(apps).set({ lastDeployedAt: daysAgo(15) }).where(eq(apps.id, app.id));
    const out = await tickApps();
    expect(out.idle).toContain(app.id);
    expect(out.idle).not.toContain(recent.id);
    const queued = transport.queued.filter((q) => q.queue === "deploys").map((q) => q.data);
    expect(queued).toContainEqual({ kind: "app_action", appId: app.id, workspaceId: app.workspaceId, action: "stop", userId: null, reason: "idle" });
    // the next tick does not queue it again
    transport.queued.length = 0;
    expect((await tickApps()).idle).not.toContain(app.id);
  });

  it("does not idle-stop an app a person started again within the period", async () => {
    const { app } = await runningApp();
    await db.update(apps).set({ lastDeployedAt: daysAgo(20) }).where(eq(apps.id, app.id));
    await audit({ workspaceId: app.workspaceId, actorLabel: "a@b", action: "app.started", targetType: "app", targetId: app.id });
    expect((await tickApps()).idle).not.toContain(app.id);
  });

  it("hourly health: healthy → unhealthy notifies once and publishes; back to healthy publishes again", async () => {
    const { app, ws } = await runningApp();
    const stale = () => db.update(apps).set({ lastHealthAt: new Date(Date.now() - APP_HEALTH_EVERY_MS - 60_000) }).where(eq(apps.id, app.id));
    await stale();
    srv.healthy = () => false;
    let out = await tickApps();
    expect(out.health.find((h) => h.appId === app.id)).toEqual({ appId: app.id, healthy: false, wentDown: true });
    expect(await appRow(app.id)).toMatchObject({ status: "running", healthy: false });
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ notificationKind: "incident", subject: expect.stringContaining("not answering") })]);
    expect(srv.callsOf("health")[0]!.args).toEqual([app.slug, String(app.port), "/api/health"]);
    expect(transport.published.map((p) => p.ev)).toContainEqual({ type: "app.updated", appId: app.id, status: "running" });

    // still down: no second notification; checked within the hour: not probed at all
    resetTransport();
    srv.calls.length = 0;
    await tickApps();
    expect(srv.callsOf("health")).toEqual([]);
    await stale();
    out = await tickApps();
    expect(out.health.find((h) => h.appId === app.id)).toEqual({ appId: app.id, healthy: false, wentDown: false });
    expect(notifications(ws.id)).toEqual([]);

    srv.healthy = () => true;
    await stale();
    out = await tickApps();
    expect(out.health.find((h) => h.appId === app.id)).toEqual({ appId: app.id, healthy: true, wentDown: false });
    expect(await appRow(app.id)).toMatchObject({ healthy: true });
  });
});

describe("interrupted releases on start", () => {
  it("deploying → failed (interrupted), app back to running when it has a current release; queued with a waiting job kept", async () => {
    const { app, ws } = await runningApp();
    const stuck = await queueRelease(app, { status: "deploying", step: "build" });
    await db.update(apps).set({ status: "deploying" }).where(eq(apps.id, app.id));
    const waiting = await queueRelease(app);
    const orphan = await queueRelease(app);
    const q = deploysQueue as unknown as { getJobs?: () => Promise<unknown[]> };
    q.getJobs = async () => [{ data: { kind: "release", releaseId: waiting.id, workspaceId: ws.id } }, { data: { kind: "app_action", appId: app.id } }];
    try {
      const failed = await recoverInterruptedReleases();
      expect(failed).toEqual(expect.arrayContaining([stuck.id, orphan.id]));
      expect(failed).not.toContain(waiting.id);
    } finally {
      delete q.getJobs;
    }
    expect(await releaseRow(stuck.id)).toMatchObject({ status: "failed", error: "interrupted" });
    expect(await releaseRow(orphan.id)).toMatchObject({ status: "failed", error: "interrupted" });
    expect(await releaseRow(waiting.id)).toMatchObject({ status: "queued" });
    expect(await appRow(app.id)).toMatchObject({ status: "running" });
    expect(await actions(app.id)).toContain("app.deploy_failed");
  });

  it("an app without a current release goes to failed", async () => {
    const f = await makeApp({ remote: makeRemote().remote, app: { status: "deploying" } });
    const stuck = await queueRelease(f.app, { status: "deploying", step: "install" });
    const q = deploysQueue as unknown as { getJobs?: () => Promise<unknown[]> };
    q.getJobs = async () => [];
    try {
      await recoverInterruptedReleases();
    } finally {
      delete q.getJobs;
    }
    expect(await releaseRow(stuck.id)).toMatchObject({ status: "failed" });
    expect(await appRow(f.app.id)).toMatchObject({ status: "failed" });
  });
});

describe("interrupted releases with a checkpoint", () => {
  /** v1 deployed; v2 left "deploying" at `step` with `checkpoint`, the fake server as that point left it */
  async function interruptedV2(step: string, checkpoint: Record<string, unknown>, server: { activated: boolean }) {
    const f = await runningApp();
    const sha2 = f.repo.commit({ "src/page.tsx": "v2" }, "v2");
    const first = await releaseRow(f.rel.id);
    const [rel] = await db
      .insert(appReleases)
      .values({ appId: f.app.id, workspaceId: f.ws.id, commit: sha2, branch: "main", trigger: "manual", status: "deploying", step: step as never, manifest: first.manifest, dbBackup: "migrated" in checkpoint ? "x" : null, checkpoint: checkpoint as never })
      .returning();
    if ("migrated" in checkpoint) await db.update(appReleases).set({ dbBackup: rel!.id }).where(eq(appReleases.id, rel!.id));
    srv.backups.add(rel!.id);
    await db.update(apps).set({ status: "deploying" }).where(eq(apps.id, f.app.id));
    srv.releases.add(sha2);
    if (server.activated) srv.current = sha2;
    srv.calls.length = 0;
    return { ...f, sha2, first, rel: rel! };
  }
  const recover = async () => {
    const q = deploysQueue as unknown as { getJobs?: () => Promise<unknown[]> };
    q.getJobs = async () => [];
    try {
      return await recoverInterruptedReleases();
    } finally {
      delete q.getJobs;
    }
  };

  it("activated and migrated: rolled back like a live failure (previous release, database restored)", async () => {
    const { app, first, rel } = await interruptedV2("health", { appStatusBefore: "running", activated: true, previousSha: "x", migrated: true }, { activated: true });
    expect(await recover()).toContain(rel.id);
    const seq = srv.sequence();
    expect(seq.slice(0, 1)).toEqual(["unit-status"]);
    expect(seq.slice(1)).toEqual(["release-activate", "env-install", "unit-install", "unit-stop", "db-restore", "unit-restart", "health", "publish"]);
    expect(srv.current).toBe(first.commit);
    expect(await releaseRow(rel.id)).toMatchObject({ status: "rolled_back", error: "interrupted" });
    expect(await appRow(app.id)).toMatchObject({ status: "running", currentReleaseId: first.id });
  });

  it("migrated but not activated: the database restored, then the old version (stopped for the migration) started", async () => {
    const { app, first, rel } = await interruptedV2("migrate", { appStatusBefore: "running", migrated: true }, { activated: false });
    srv.unit = "inactive";
    await recover();
    expect(srv.sequence()).toEqual(["unit-status", "db-restore", "env-install", "unit-start"]);
    expect(srv.current).toBe(first.commit);
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", error: "interrupted" });
    expect(await appRow(app.id)).toMatchObject({ status: "running", statusMessage: null });
  });

  it("server unreachable: nothing undone, app failed with statusMessage interrupted", async () => {
    const { app, rel } = await interruptedV2("health", { appStatusBefore: "running", activated: true }, { activated: true });
    srv.unreachable = true;
    await recover();
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", error: "interrupted" });
    expect(await appRow(app.id)).toMatchObject({ status: "failed", statusMessage: "interrupted" });
  });

  it("nothing switched yet: rows only, the app back to the status it had before (stopped)", async () => {
    const { app, rel } = await interruptedV2("build", { appStatusBefore: "stopped" }, { activated: false });
    await recover();
    expect(srv.calls).toEqual([]);
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", error: "interrupted" });
    expect(await appRow(app.id)).toMatchObject({ status: "stopped" });
  });
});

describe("release log", () => {
  it("redacts each secret literally (also split across chunks), and the shared high-severity patterns", () => {
    const r = new Redactor();
    r.add("hunter2-is-long", "1", null, "abc"); // too short values are not replaced
    const l = new ReleaseLog("00000000-0000-0000-0000-000000000000", r);
    l.write("token=hunt");
    l.write("er2-is-long 1 abc\n");
    l.line("key ghp_" + "a".repeat(36));
    const t = l.text(true);
    expect(t).toContain("token=[REDACTED] 1 abc");
    expect(t).not.toContain("hunter2");
    expect(t).not.toContain("a".repeat(36));
  });

  it("holds back the end of an unfinished line until it is complete (a secret still arriving never shows halfway)", () => {
    const r = new Redactor();
    r.add("supersecretvalue");
    const l = new ReleaseLog("00000000-0000-0000-0000-000000000000", r);
    l.write("done\nprinting supers");
    expect(l.text()).toBe("done\n");
    l.write("ecretvalue\n");
    expect(l.text()).toBe("done\nprinting [REDACTED]\n");
  });

  it("is capped at 200 KB keeping the tail, cut at a line break", () => {
    const r = new Redactor();
    const l = new ReleaseLog("00000000-0000-0000-0000-000000000000", r);
    for (let i = 0; i < 20_000; i++) l.write(`line ${i} ${"x".repeat(20)}\n`);
    const t = l.text(true);
    expect(t.length).toBeLessThanOrEqual(RELEASE_LOG_MAX + 64);
    expect(t.startsWith("[… earlier output cut …]\nline ")).toBe(true);
    expect(t.endsWith(`line 19999 ${"x".repeat(20)}\n`)).toBe(true);
  });
});

describe("destructive migration warning", () => {
  it.each([
    ["DROP TABLE users;", true],
    ["alter table orders drop column note;", true],
    ["ALTER TABLE x DROP CONSTRAINT y;", true],
    ["TRUNCATE sessions;", true],
    ["DELETE FROM carts WHERE 1=1;", true],
    ["CREATE TABLE orders (id int);", false],
    ["ALTER TABLE orders ADD COLUMN note text;", false],
  ])("%s → %s", (line, destructive) => {
    expect(DESTRUCTIVE_SQL_RE.test(line)).toBe(destructive);
  });

  it("looks only at added lines of migration files (any depth: prisma/migrations, drizzle, migrations)", async () => {
    const repo = makeRemote();
    const sha = repo.commit({
      "apps/api/drizzle/0002.sql": "DROP TABLE legacy;\n",
      "db/migrations/0003.sql": "DELETE FROM carts;\n",
      "src/notes.md": "We will DROP TABLE later\n",
      "prisma/migrations/0001_init/migration.sql": null,
    });
    const lines = await destructiveMigrationLines(repo.remote, repo.first, sha);
    expect(lines.sort()).toEqual(["DELETE FROM carts;", "DROP TABLE legacy;"]);
  });
});
