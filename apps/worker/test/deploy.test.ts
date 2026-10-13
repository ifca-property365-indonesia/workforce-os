import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { apps, appReleases, auditLog, db, servers, workspaces } from "@wfos/db";
import type { NotifyJob, RealtimeEvent } from "@wfos/shared";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { deployControl, runRelease } from "../src/deploy/pipeline";
import { makeApp, makeRemote, FakeServer, fastDeploys, queueRelease, SECRET_ENV, tarNames, MANIFEST } from "./deploy-fixtures";
import { resetTransport, transport } from "./transport";

// SSH is never real: sshExec / sftpPut answer like helper v2 (FakeServer); the repository is a real local git repo.
vi.mock("@wfos/shared/ssh", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/ssh")>();
  return { ...real, sshExec: vi.fn(), sftpPut: vi.fn() };
});

let srv: FakeServer;
let pub: ReturnType<typeof fastDeploys>;
beforeEach(() => {
  resetTransport();
  srv = new FakeServer();
  srv.install();
  pub = fastDeploys();
});

const releaseRow = async (id: string) => (await db.select().from(appReleases).where(eq(appReleases.id, id)))[0]!;
const appRow = async (id: string) => (await db.select().from(apps).where(eq(apps.id, id)))[0]!;
const audits = async (appId: string) => (await db.select().from(auditLog).where(eq(auditLog.targetId, appId))).map((a) => ({ action: a.action, details: a.details }));
const notifications = (workspaceId: string) => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob).filter((n) => n.workspaceId === workspaceId);
const events = (workspaceId: string) => transport.published.filter((p) => p.workspaceId === workspaceId).map((p) => p.ev as RealtimeEvent);

/** Everything that leaves the pipeline for people: log, error, audit details, notifications, events. */
async function everythingVisible(releaseId: string, appId: string, workspaceId: string): Promise<string> {
  const r = await releaseRow(releaseId);
  return JSON.stringify([r.log, r.error, await audits(appId), notifications(workspaceId), events(workspaceId)]);
}

/** Deploy the first version (database + migrate) successfully. */
async function deployFirst() {
  const repo = makeRemote();
  const f = await makeApp({ remote: repo.remote });
  const rel = await queueRelease(f.app, { createdBy: f.user.id });
  expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
  return { ...f, repo, rel };
}

describe("release pipeline", () => {
  it("first deploy: every step in order, the right statuses, the env and preview login, nothing secret in the log", async () => {
    const repo = makeRemote();
    const { ws, user, app, server } = await makeApp({ remote: repo.remote });
    const rel = await queueRelease(app, { createdBy: user.id });
    // the build prints a secret, split across two output chunks
    srv.replies["build-run:build"] = { code: 0, data: [`building with SMTP_PASSWORD=${SECRET_ENV.slice(0, 10)}`, `${SECRET_ENV.slice(10)} done\n`] };

    expect(await runRelease(rel.id, ws.id)).toBe("deployed");

    expect(srv.sequence()).toEqual([
      "app-init",
      "release-unpack",
      "env-install",
      "db-create",
      "build-run:install",
      "build-run:build",
      // no backup: nothing was deployed before
      "build-run:migrate",
      "release-activate",
      "unit-install",
      "unit-restart",
      "health",
      "publish",
      "release-prune",
    ]);
    const sha = repo.first;
    // upload: git archive of exactly that commit into the incoming folder, 0640
    expect(srv.uploads).toHaveLength(1);
    expect(srv.uploads[0]).toMatchObject({ path: `/home/wfos-apps/incoming/${app.slug}-${sha}.tar.gz`, mode: 0o640 });
    expect(tarNames(srv.uploads[0]!.data)).toEqual(expect.arrayContaining(["wfos-app.json", "package.json", "prisma/migrations/0001_init/migration.sql"]));
    // arguments as the contract table has them
    expect(srv.callsOf("release-unpack")[0]!.args).toEqual([app.slug, sha]);
    expect(srv.callsOf("build-run").map((c) => c.args)).toEqual([
      [app.slug, sha, "install", "900", "1536"],
      [app.slug, sha, "build", "1200", "1536"],
      [app.slug, sha, "migrate", "300", "1024"],
    ]);
    expect(srv.callsOf("build-run").map((c) => c.stdin)).toEqual(["pnpm install --frozen-lockfile\n", "pnpm build\n", "pnpm db:migrate\n"]);
    expect(srv.callsOf("unit-install")[0]).toEqual({ cmd: "unit-install", args: [app.slug, String(app.port), "512", "--database"], stdin: "pnpm start -H 127.0.0.1 -p $PORT\n" });
    expect(srv.callsOf("health")[0]!.args).toEqual([app.slug, String(app.port), "/api/health"]);

    const after = await appRow(app.id);
    // env file: the person's variables plus the platform's
    const env = Object.fromEntries(srv.env.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const dbPw = decryptSecret(after.dbPasswordEnc!);
    expect(dbPw).toMatch(/^[0-9a-f]{64}$/);
    expect(env).toEqual({
      SMTP_PASSWORD: SECRET_ENV,
      FEATURE: "on",
      PORT: String(app.port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      APP_URL: `https://${app.domain}`,
      APP_SECRET: decryptSecret(after.appSecretEnc!),
      APP_VERSION: sha,
      APP_DATA_DIR: `/srv/wfos-apps/${app.slug}/data`,
      // the port names the socket file: /run/wfos-apps-pg/.s.PGSQL.5433
      DATABASE_URL: `postgresql://app_${app.slug.replace(/-/g, "_")}:${dbPw}@localhost:5433/app_${app.slug.replace(/-/g, "_")}?host=/run/wfos-apps-pg`,
    });
    expect(env.APP_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(srv.callsOf("db-create")[0]!.stdin).toBe(`${dbPw}\n`);
    // preview login: bcrypt (cost 10) of the generated password, user "preview"; the public check logs in with it
    const pw = decryptSecret(after.accessPasswordEnc!);
    expect(pw).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
    const publishCall = srv.callsOf("publish")[0]!;
    expect(publishCall.args).toEqual([app.slug, String(app.port), "--auth"]);
    const [user_, hash] = publishCall.stdin!.trim().split(":");
    expect(user_).toBe("preview");
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(pw, hash!)).toBe(true);
    expect(pub.publicCalls).toEqual([{ url: `https://${app.domain}/api/health`, headers: { authorization: `Basic ${Buffer.from(`preview:${pw}`).toString("base64")}` } }]);

    // statuses
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "deployed", step: "cleanup", commit: sha, commitSubject: "First version", error: null, warnings: ["first_publish", "new_database"] });
    expect(r.checkpoint).toEqual({ appStatusBefore: "new", activated: true, previousSha: "none", migrated: true });
    expect(r.manifest).toMatchObject(MANIFEST);
    expect(r.startedAt).toBeTruthy();
    expect(r.finishedAt).toBeTruthy();
    expect(after).toMatchObject({ status: "running", currentReleaseId: rel.id, healthy: true, memoryMb: 512, statusMessage: null });
    expect(after.lastDeployedAt).toBeTruthy();
    void server;

    // log: a header per step with its duration, build output streamed in, no secret at all
    expect(r.log).toMatch(/==> prepare\n/);
    expect(r.log).toMatch(/<== build ok \(\d+\.\d s\)/);
    expect(r.log).toContain("building with SMTP_PASSWORD=[REDACTED]");
    const visible = await everythingVisible(rel.id, app.id, ws.id);
    for (const secret of [SECRET_ENV, SECRET_ENV.slice(10), dbPw, pw, env.APP_SECRET!, hash!]) expect(visible).not.toContain(secret);

    // events, audit, notification to the person who deployed
    const steps = events(ws.id).filter((e) => e.type === "release.updated").map((e) => (e as { step: string | null }).step);
    expect(steps).toEqual(expect.arrayContaining(["prepare", "upload", "install", "activate", "health", "public_check", "cleanup"]));
    expect(events(ws.id)).toContainEqual({ type: "app.updated", appId: app.id, status: "deploying" });
    expect(events(ws.id).at(-1)).toEqual({ type: "app.updated", appId: app.id, status: "running" });
    expect((await audits(app.id)).map((a) => a.action)).toEqual(["app.deployed"]);
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ notificationKind: "task_done", userId: user.id, link: `/apps/${app.id}` })]);
  });

  it("a second deploy backs up the database before migrating, supersedes the previous release and computes the warnings", async () => {
    const { repo, ws, app, rel: first } = await deployFirst();
    const sha2 = repo.commit(
      {
        "prisma/migrations/0002_drop/migration.sql": "ALTER TABLE orders DROP COLUMN note;\nDROP TABLE legacy;\n",
        "package.json": JSON.stringify({ name: "kopi", scripts: { build: "next build", start: "next start", postinstall: "curl x" } }),
        "wfos-app.json": JSON.stringify({ ...MANIFEST, memoryMb: 768 }),
      },
      "Second version",
    );
    srv.calls.length = 0;
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    const seq = srv.sequence();
    // maintenance: the old version is stopped before the dump, so nothing writes while the database is migrated
    expect(seq.slice(seq.indexOf("build-run:build"), seq.indexOf("release-activate"))).toEqual(["build-run:build", "unit-stop", "db-dump", "build-run:migrate"]);
    expect((await releaseRow(rel.id)).log).toContain("maintenance: old version stopped for the migration");
    expect(srv.callsOf("db-dump")[0]!.args).toEqual([app.slug, rel.id]);
    expect(srv.callsOf("unit-install")[0]!.args).toEqual([app.slug, String(app.port), "768", "--database"]);
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "deployed", commit: sha2, dbBackup: rel.id });
    expect(r.warnings).toEqual(["manifest_changed", "scripts_changed", "destructive_migration"]);
    expect(await releaseRow(first.id)).toMatchObject({ status: "superseded" });
    expect(await appRow(app.id)).toMatchObject({ currentReleaseId: rel.id, memoryMb: 768 });
    // the same database password is kept (db-create is idempotent, no reset)
    expect(srv.callsOf("db-create")[0]!.args).toEqual([app.slug]);
  });

  it("a public app: the site without a login, the public check without one, the public_access warning", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote, app: { accessMode: "public" } });
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    expect(srv.callsOf("publish")[0]).toMatchObject({ args: [app.slug, String(app.port)], stdin: undefined });
    expect(pub.publicCalls[0]!.headers).toEqual({});
    expect((await releaseRow(rel.id)).warnings).toContain("public_access");
    expect((await appRow(app.id)).accessPasswordEnc).toBeNull();
  });

  it("build memory is capped at half the server's memory", async () => {
    const repo = makeRemote();
    const { ws, app, server } = await makeApp({ remote: repo.remote });
    await db.update(servers).set({ info: { ...server.info!, memTotalMb: 1600 } }).where(eq(servers.id, server.id));
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    expect(srv.callsOf("build-run").map((c) => c.args[4])).toEqual(["800", "800", "800"]);
  });

  it("refuses an exact commit that is not in the repository", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote });
    const rel = await queueRelease(app, { commit: "a".repeat(40) });
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/Commit aaaaaaaaaaaa is not in the repository/);
    expect(srv.calls).toEqual([]);
  });

  it.each([
    ["missing", { "wfos-app.json": null }, /wfos-app\.json is missing/],
    ["not JSON", { "wfos-app.json": "{ nope" }, /wfos-app\.json is not valid JSON/],
    ["an unknown key", { "wfos-app.json": JSON.stringify({ type: "nextjs", buidl: "x" }) }, /wfos-app\.json is invalid: .*buidl/],
    ["a wrong type", { "wfos-app.json": JSON.stringify({ type: "rails" }) }, /wfos-app\.json is invalid: .*type/],
  ])("manifest %s → failed at prepare with the reason, nothing runs on the server", async (_n, files, re) => {
    const repo = makeRemote();
    repo.commit(files as Record<string, string | null>);
    const { ws, app } = await makeApp({ remote: repo.remote });
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "failed", step: "prepare" });
    expect(r.error).toMatch(re);
    expect(srv.calls).toEqual([]);
    // a new app with nothing deployed: failed
    expect(await appRow(app.id)).toMatchObject({ status: "failed", currentReleaseId: null });
    expect((await audits(app.id)).map((a) => a.action)).toEqual(["app.deploy_failed"]);
  });

  it.each([
    ["the kill switch is engaged", async (wsId: string) => void (await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, wsId))), /kill switch/],
    ["the workspace is in dry run (demo mode)", async (wsId: string) => void (await db.update(workspaces).set({ demoMode: true }).where(eq(workspaces.id, wsId))), /Dry run/],
    ["the server is not ready", async (wsId: string) => void (await db.update(servers).set({ status: "error" }).where(eq(servers.workspaceId, wsId))), /not ready/],
  ])("refused when %s: release failed, the app untouched, no SSH", async (_n, arrange, re) => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote });
    await arrange(ws.id);
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "failed", step: "prepare" });
    expect(r.error).toMatch(re);
    expect(await appRow(app.id)).toMatchObject({ status: "new" });
    expect(srv.calls).toEqual([]);
    expect(events(ws.id)).not.toContainEqual(expect.objectContaining({ type: "app.updated", status: "deploying" }));
  });

  it("refused when the server's helper is older than WFOS_HELPER_VERSION", async () => {
    const repo = makeRemote();
    const { ws, app, server } = await makeApp({ remote: repo.remote });
    await db.update(servers).set({ info: { ...server.info!, helperVersion: 1 } }).where(eq(servers.id, server.id));
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/version 1, version 2 is needed: run the new prepare\.sh/);
  });

  it("refused when the server already runs maxRunningApps other apps; an app that already runs may still deploy", async () => {
    const repo = makeRemote();
    const { ws, app, server } = await makeApp({ remote: repo.remote, server: { maxRunningApps: 2 } });
    for (const n of [1, 2]) {
      await db.insert(apps).values({ workspaceId: ws.id, serverId: server.id, name: `other ${n}`, slug: `other-${n}-${app.slug}`.slice(0, 30), domain: `o${n}-${app.domain}`, port: app.port + 1000 + n, status: n === 1 ? "running" : "deploying" });
    }
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/already runs 2 apps \(at most 2\)/);
    expect(srv.calls).toEqual([]);

    await db.update(apps).set({ status: "running" }).where(eq(apps.id, app.id));
    const again = await queueRelease(app);
    expect(await runRelease(again.id, ws.id)).toBe("deployed");
  });

  it("a release that is not queued is not run again (duplicate job)", async () => {
    const { ws, rel } = await deployFirst();
    srv.calls.length = 0;
    expect(await runRelease(rel.id, ws.id)).toBeNull();
    expect(srv.calls).toEqual([]);
  });

  it("failure in build: the running version is untouched, its env is put back, release failed, app still running", async () => {
    const { repo, ws, app, rel: first, user } = await deployFirst();
    const sha2 = repo.commit({ "src/page.tsx": "broken" }, "Broken build");
    srv.calls.length = 0;
    srv.replies["build-run:build"] = { code: 1, data: "Type error: nope\n", stderr: `Type error: nope ${SECRET_ENV}` };
    const rel = await queueRelease(app, { createdBy: user.id });
    resetTransport();
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    const seq = srv.sequence();
    expect(seq).toEqual(["app-init", "release-unpack", "env-install", "db-create", "build-run:install", "build-run:build", "env-install"]);
    expect(srv.current).toBe(repo.first);
    expect(srv.env).toContain(`APP_VERSION=${repo.first}\n`);
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "failed", step: "build", commit: sha2 });
    expect(r.error).toMatch(/build-run failed \(exit 1\)/);
    expect(await appRow(app.id)).toMatchObject({ status: "running", currentReleaseId: first.id, healthy: true });
    expect(await releaseRow(first.id)).toMatchObject({ status: "deployed" });
    expect(await everythingVisible(rel.id, app.id, ws.id)).not.toContain(SECRET_ENV);
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ notificationKind: "task_failed", userId: user.id })]);
    expect(notifications(ws.id)[0]!.text).toContain("The previous version keeps running");
  });

  it("a guard refusal (disk_low) is reported as such", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote });
    srv.replies["release-unpack"] = { code: 3, stderr: "wfos-app-helper: disk_low: 900 MB free under /srv/wfos-apps (2048 MB needed)\n" };
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ step: "unpack", error: expect.stringMatching(/too little free disk space \(disk_low\)/) });
  });

  it("failure in health after migrating: rolled back to the previous release, database restored, published again", async () => {
    const { repo, ws, app, rel: first } = await deployFirst();
    const sha2 = repo.commit({ "src/page.tsx": "crashes at start" }, "Crashes");
    srv.calls.length = 0;
    srv.healthy = (sha) => sha !== sha2;
    const rel = await queueRelease(app);
    resetTransport();
    expect(await runRelease(rel.id, ws.id)).toBe("rolled_back");
    const seq = srv.sequence();
    expect(seq.slice(seq.indexOf("release-activate"))).toEqual([
      "release-activate",
      "unit-install",
      "unit-restart",
      "health",
      "unit-status",
      // rollback
      "release-activate",
      "env-install",
      "unit-install",
      "unit-stop",
      "db-restore",
      "unit-restart",
      "health",
      "publish",
    ]);
    expect(srv.callsOf("release-activate").map((c) => c.args[1])).toEqual([sha2, repo.first]);
    expect(srv.callsOf("db-restore")[0]!.args).toEqual([app.slug, rel.id]);
    expect(srv.current).toBe(repo.first);
    expect(srv.env).toContain(`APP_VERSION=${repo.first}\n`);
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "rolled_back", step: "health", dbBackup: rel.id });
    expect(r.error).toMatch(/did not answer 2xx on \/api\/health/);
    expect(r.log).toMatch(/<== rollback done/);
    expect(await appRow(app.id)).toMatchObject({ status: "running", currentReleaseId: first.id, healthy: true });
    expect((await audits(app.id)).map((a) => a.action)).toContain("app.rolled_back");
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ notificationKind: "task_failed", subject: expect.stringContaining("rolled back") })]);
  });

  it("failure of the public check (after activate) also rolls back", async () => {
    const { repo, ws, app } = await deployFirst();
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    pub.setPublicStatus(401);
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("rolled_back");
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ step: "public_check", error: expect.stringMatching(/did not answer 2xx from the internet \(HTTP 401\)/) });
    expect(pub.publicCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("first deploy failing health: stopped and unpublished, release failed, app failed", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote });
    srv.healthy = () => false;
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    const seq = srv.sequence();
    expect(seq.slice(seq.indexOf("unit-restart"))).toEqual(["unit-restart", "health", "unit-status", "unit-stop", "unpublish"]);
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", step: "health" });
    expect(await appRow(app.id)).toMatchObject({ status: "failed", currentReleaseId: null, healthy: false });
    expect(notifications(ws.id).at(-1)!.text).toContain("No version of the app is running");
  });
});

describe("review fixes", () => {
  it("a database without the server's postgresPort is refused before anything is sent to the server", async () => {
    const repo = makeRemote();
    const { ws, app, server } = await makeApp({ remote: repo.remote });
    await db.update(servers).set({ info: { ...server.info!, postgresPort: null } }).where(eq(servers.id, server.id));
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ step: "prepare", error: expect.stringMatching(/needs a database, but server dev reports no apps PostgreSQL cluster/) });
    expect(srv.calls).toEqual([]);
  });

  it("memoryMb over half of the server's memory is refused in prepare", async () => {
    const repo = makeRemote({ "wfos-app.json": JSON.stringify({ ...MANIFEST, memoryMb: 1024 }) });
    const { ws, app, server } = await makeApp({ remote: repo.remote });
    await db.update(servers).set({ info: { ...server.info!, memTotalMb: 1600 } }).where(eq(servers.id, server.id));
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ step: "prepare", error: expect.stringMatching(/memoryMb 1024, more than half of server dev's memory \(800 MB allowed\)/) });
    expect(srv.calls).toEqual([]);
  });

  it("deploying the commit that already runs is refused (the helper never unpacks over the running release)", async () => {
    const { ws, app } = await deployFirst();
    srv.calls.length = 0;
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ step: "prepare", error: expect.stringMatching(/is the version running now/) });
    expect(srv.calls).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ status: "running" });
  });

  it("a running release without a stored manifest refuses the deploy before anything changes", async () => {
    const { repo, ws, app, rel: first } = await deployFirst();
    await db.update(appReleases).set({ manifest: null }).where(eq(appReleases.id, first.id));
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    srv.calls.length = 0;
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/has no valid stored manifest/);
    expect(srv.calls).toEqual([]);
    expect(await appRow(app.id)).toMatchObject({ status: "running" });
  });

  it("a failed migration: database restored while the old version is stopped, then the old version started again", async () => {
    const { repo, ws, app, rel: first } = await deployFirst();
    repo.commit({ "prisma/migrations/0002/migration.sql": "ALTER TABLE orders ADD COLUMN x int;\n" }, "v2");
    srv.calls.length = 0;
    srv.replies["build-run:migrate"] = { code: 1, stderr: "migration failed\n" };
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    const seq = srv.sequence();
    expect(seq.slice(seq.indexOf("build-run:build"))).toEqual(["build-run:build", "unit-stop", "db-dump", "build-run:migrate", "db-restore", "env-install", "unit-start"]);
    expect(srv.callsOf("db-restore")[0]!.args).toEqual([app.slug, rel.id]);
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", step: "migrate", checkpoint: { appStatusBefore: "running", migrated: true } });
    expect(await appRow(app.id)).toMatchObject({ status: "running", currentReleaseId: first.id, statusMessage: null });
    expect(srv.unit).toBe("active");
    expect((await releaseRow(rel.id)).log).toContain("maintenance over: the old version runs again");
  });

  it("the old version failing to start again after a failed migration: app failed (restart_failed)", async () => {
    const { repo, ws, app } = await deployFirst();
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    srv.replies["build-run:migrate"] = { code: 1 };
    srv.replies["unit-start"] = { code: 1, stderr: "wfos-app-helper: systemctl failed\n" };
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await appRow(app.id)).toMatchObject({ status: "failed", statusMessage: "restart_failed" });
  });

  it("access mode / preview password are read again right before publish and the public check", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote });
    // an Admin switches the app to public while it builds
    srv.replies["build-run:build"] = () => {
      void db.update(apps).set({ accessMode: "public" }).where(eq(apps.id, app.id)).then(() => undefined);
      return undefined;
    };
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    // prepare saw password mode (no public_access warning), publish saw public
    expect((await releaseRow(rel.id)).warnings).not.toContain("public_access");
    expect(srv.callsOf("publish")[0]!.args).toEqual([app.slug, String(app.port)]);
    expect(pub.publicCalls[0]!.headers).toEqual({});
  });
});

describe("helper refusals in a deploy", () => {
  it("firewall_off in build-run (first deploy): release failed with what to do, app failed with statusMessage firewall_off", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote });
    srv.replies["build-run:install"] = { code: 3, stderr: "wfos-app-helper: firewall_off: the app firewall is not loaded\n" };
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ step: "install", error: expect.stringMatching(/firewall is not loaded on the server; the Owner should start wfos-apps-firewall\.service or re-run prepare\.sh \(firewall_off\)/) });
    expect(await appRow(app.id)).toMatchObject({ status: "failed", statusMessage: "firewall_off" });
  });

  it("server_full from app-init: statusMessage server_full; an existing version keeps running", async () => {
    const { repo, ws, app } = await deployFirst();
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    srv.replies["app-init"] = { code: 3, stderr: "wfos-app-helper: server_full: 40 apps exist on this server (at most 40)\n" };
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await appRow(app.id)).toMatchObject({ status: "running", statusMessage: "server_full" });
  });

  it("a person-set env name the platform owns is refused in prepare, before anything is sent", async () => {
    const repo = makeRemote();
    const { ws, app } = await makeApp({ remote: repo.remote, app: { envEnc: encryptSecret(JSON.stringify({ COREPACK_HOME: "/tmp", PATH: "/bin" })) } });
    const rel = await queueRelease(app);
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ step: "prepare", error: expect.stringMatching(/COREPACK_HOME, PATH are set by the platform/) });
    expect(srv.calls).toEqual([]);
  });
});

describe("rollback releases", () => {
  async function twoVersions() {
    const f = await deployFirst();
    const sha2 = f.repo.commit({ "src/page.tsx": "v2" }, "v2");
    const second = await queueRelease(f.app);
    expect(await runRelease(second.id, f.ws.id)).toBe("deployed");
    srv.calls.length = 0;
    srv.uploads.length = 0;
    const first = await releaseRow(f.rel.id);
    const rb = await queueRelease(f.app, { trigger: "rollback", rollbackOfId: first.id, commit: first.commit, branch: first.branch, manifest: first.manifest });
    return { ...f, sha2, second, first, rb };
  }

  it("with the release folder still on the server: switch back, env, unit, restart — no build, no database restore", async () => {
    const { ws, app, second, first, rb } = await twoVersions();
    expect(await runRelease(rb.id, ws.id)).toBe("deployed");
    expect(srv.sequence()).toEqual(["release-activate", "env-install", "unit-install", "unit-restart", "health", "publish", "release-prune"]);
    expect(srv.uploads).toEqual([]);
    expect(srv.callsOf("db-restore")).toEqual([]);
    expect(srv.current).toBe(first.commit);
    const r = await releaseRow(rb.id);
    expect(r).toMatchObject({ status: "deployed", commit: first.commit });
    expect(r.log).toMatch(/a rollback does not restore the database/);
    expect(await releaseRow(second.id)).toMatchObject({ status: "superseded" });
    expect(await appRow(app.id)).toMatchObject({ status: "running", currentReleaseId: rb.id });
  });

  it("with the folder gone (release_missing): the commit is built again with the full pipeline", async () => {
    const { ws, app, first, rb } = await twoVersions();
    srv.releases.delete(first.commit);
    expect(await runRelease(rb.id, ws.id)).toBe("deployed");
    const seq = srv.sequence();
    expect(seq[0]).toBe("release-activate");
    expect(seq.slice(1)).toEqual(
      expect.arrayContaining(["app-init", "release-unpack", "env-install", "build-run:install", "build-run:build", "release-activate", "unit-install", "unit-restart", "publish"]),
    );
    expect(srv.uploads.map((u) => u.path)).toEqual([`/home/wfos-apps/incoming/${app.slug}-${first.commit}.tar.gz`]);
    expect(srv.current).toBe(first.commit);
    expect((await releaseRow(rb.id)).log).toMatch(/is no longer on the server: building it again/);
  });
});

describe("interplay", () => {
  it("on shutdown a deploy that has not switched anything on stops at its next step and fails cleanly", async () => {
    const { repo, ws, app, rel: first } = await deployFirst();
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    srv.calls.length = 0;
    srv.replies["build-run:install"] = () => {
      deployControl.stopping = true;
      return { code: 0 };
    };
    const rel = await queueRelease(app);
    try {
      expect(await runRelease(rel.id, ws.id)).toBe("failed");
    } finally {
      deployControl.stopping = false;
    }
    expect(srv.sequence()).toEqual(["app-init", "release-unpack", "env-install", "db-create", "build-run:install", "env-install"]);
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", step: "install", error: expect.stringMatching(/shutting down/) });
    expect(await appRow(app.id)).toMatchObject({ status: "running", currentReleaseId: first.id });
  });

  it("only the app's own workspace: a job naming another workspace does nothing", async () => {
    const repo = makeRemote();
    const a = await makeApp({ remote: repo.remote });
    const b = await makeApp({ remote: repo.remote });
    const rel = await queueRelease(a.app);
    expect(await runRelease(rel.id, b.ws.id)).toBeNull();
    expect(await releaseRow(rel.id)).toMatchObject({ status: "queued" });
    expect(srv.calls).toEqual([]);
    const rows = await db.select().from(appReleases).where(and(eq(appReleases.appId, a.app.id), eq(appReleases.status, "queued")));
    expect(rows).toHaveLength(1);
  });
});
