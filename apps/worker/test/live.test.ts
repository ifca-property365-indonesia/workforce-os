import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { appEnvironments, apps, appReleases, auditLog, db } from "@wfos/db";
import type { DeployJob, DomainCheck, NotifyJob, RealtimeEvent } from "@wfos/shared";
import { checkDomains } from "@wfos/shared/dns";
import { decryptSecret } from "@wfos/shared/server";
import { runAppAction } from "../src/deploy/actions";
import { runRelease } from "../src/deploy/pipeline";
import { tickApps, APP_HEALTH_EVERY_MS } from "../src/scheduler/apps";
import { FakeServer, fastDeploys, LIVE_ENV, makeApp, makeLive, makeRemote, okDns, queueRelease, SECRET_ENV } from "./deploy-fixtures";
import { resetTransport, transport } from "./transport";

// SSH is never real (FakeServer answers like helper v3); public DNS is never asked (checkDomains is mocked).
vi.mock("@wfos/shared/ssh", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/ssh")>();
  return { ...real, sshExec: vi.fn(), sftpPut: vi.fn() };
});
vi.mock("@wfos/shared/dns", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/dns")>();
  return { ...real, checkDomains: vi.fn() };
});

let srv: FakeServer;
let pub: ReturnType<typeof fastDeploys>;
beforeEach(() => {
  resetTransport();
  srv = new FakeServer();
  srv.install();
  pub = fastDeploys();
  vi.mocked(checkDomains).mockReset();
  vi.mocked(checkDomains).mockImplementation(async (names) => okDns(names));
});

const envRow = async (id: string) => (await db.select().from(appEnvironments).where(eq(appEnvironments.id, id)))[0];
const releaseRow = async (id: string) => (await db.select().from(appReleases).where(eq(appReleases.id, id)))[0]!;
const notifications = (workspaceId: string) => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob).filter((n) => n.workspaceId === workspaceId);
const envFile = () => Object.fromEntries(srv.env.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60_000);
const job = (app: { id: string; workspaceId: string }, action: "stop" | "start" | "remove" | "republish", over: Partial<Extract<DeployJob, { kind: "app_action" }>> = {}) =>
  ({ kind: "app_action", appId: app.id, workspaceId: app.workspaceId, action, userId: null, ...over }) as Extract<DeployJob, { kind: "app_action" }>;

/** An Owner's app whose preview runs its first commit (deployed), plus its (not yet deployed) live environment. */
async function previewDeployed(liveOver: Parameters<typeof makeLive>[2] = {}) {
  const repo = makeRemote();
  const f = await makeApp({ remote: repo.remote, role: "OWNER" });
  const prev = await queueRelease(f.app, { createdBy: f.user.id });
  expect(await runRelease(prev.id, f.ws.id)).toBe("deployed");
  const previewEnv = srv.env;
  const live = await makeLive(f.app, f.server.id, liveOver);
  srv.calls.length = 0;
  pub.publicCalls.length = 0;
  resetTransport();
  const prevRow = await releaseRow(prev.id);
  /** a release of the preview's commit to live, as the web queues it ("Release to LIVE") */
  const toLive = (over: Parameters<typeof queueRelease>[1] = {}) =>
    queueRelease(f.app, { environmentId: live.id, commit: prevRow.commit, promotedFromReleaseId: prev.id, createdBy: f.user.id, ...over });
  return { ...f, repo, prev: prevRow, live, previewEnv, toLive };
}

describe("live releases", () => {
  it("publish with the client's domain, its alias and --index; its own env, APP_URL, database and secrets", async () => {
    const { ws, app, server, preview, live, prev, previewEnv, toLive } = await previewDeployed();
    const rel = await toLive();
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");

    // every helper call names the live instance, never the preview's
    const inst = `${app.slug}-live`;
    expect(live.instanceName).toBe(inst);
    expect(srv.calls.every((c) => c.args[0] === inst)).toBe(true);
    expect(srv.uploads.at(-1)!.path).toBe(`/home/wfos-apps/incoming/${inst}-${prev.commit}.tar.gz`);
    // public: no --auth; the domain, the www alias (301), indexable
    expect(srv.callsOf("publish")).toEqual([
      { cmd: "publish", args: [inst, String(live.port), "--domain", live.domain, "--alias", `www.${live.domain}`, "--index"], stdin: undefined },
    ]);
    // B2: a first live release starts in the active slot (blue = the environment's port)
    expect(srv.callsOf("unit-install")[0]!.args).toEqual([inst, String(live.port), "512", "--database", "--slot", "blue"]);
    expect(srv.callsOf("db-create")[0]!.args).toEqual([inst]);
    expect(pub.publicCalls).toEqual([{ url: `https://${live.domain}/api/health`, headers: {} }]);

    // its own env file: live variables only, its URL, data folder, database and APP_SECRET
    const env = envFile();
    const liveRow = (await envRow(live.id))!;
    const previewRow = (await envRow(preview.id))!;
    const livePw = decryptSecret(liveRow.dbPasswordEnc!);
    expect(env).toMatchObject({
      SMTP_PASSWORD: LIVE_ENV,
      APP_URL: `https://${live.domain}`,
      APP_DATA_DIR: `/srv/wfos-apps/${inst}/data`,
      APP_SECRET: decryptSecret(liveRow.appSecretEnc!),
      DATABASE_URL: `postgresql://app_${inst.replace(/-/g, "_")}:${livePw}@localhost:5433/app_${inst.replace(/-/g, "_")}?host=/run/wfos-apps-pg`,
    });
    expect(env.FEATURE).toBeUndefined();
    // both slots share the env file; each unit sets its own PORT
    expect(env.PORT).toBeUndefined();
    expect(srv.env).not.toContain(SECRET_ENV);
    expect(livePw).not.toBe(decryptSecret(previewRow.dbPasswordEnc!));
    expect(liveRow.appSecretEnc && decryptSecret(liveRow.appSecretEnc)).not.toBe(decryptSecret(previewRow.appSecretEnc!));
    expect(previewEnv).toContain(`APP_URL=https://${preview.domain}\n`);
    // a public live site has no access password
    expect(liveRow.accessPasswordEnc).toBeNull();

    // rows: live runs the release, the preview is untouched; DNS asked for both names against the server's host
    expect(checkDomains).toHaveBeenCalledWith([live.domain, `www.${live.domain}`], server.host);
    expect(liveRow).toMatchObject({ status: "running", currentReleaseId: rel.id, healthy: true, dnsCheck: expect.objectContaining({ status: "ok" }) });
    expect(previewRow).toMatchObject({ status: "running", currentReleaseId: prev.id });
    expect(await releaseRow(prev.id)).toMatchObject({ status: "deployed" });
    expect(await releaseRow(rel.id)).toMatchObject({ status: "deployed", environmentId: live.id, promotedFromReleaseId: prev.id });
    // the notification and the audit name the environment
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ subject: `LIVE updated: ${app.name} (LIVE)` })]);
    expect(transport.published.map((p) => p.ev as RealtimeEvent)).toContainEqual({ type: "app.updated", appId: app.id, status: "running", environmentId: live.id });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.targetId, app.id), eq(auditLog.action, "app.deployed")));
    expect(audits.map((a) => a.details)).toContainEqual(expect.objectContaining({ releaseId: rel.id, environmentId: live.id, environment: "live" }));
  });

  it("password access on live: --auth with the bcrypt line, and the domain flags", async () => {
    const { ws, live, toLive } = await previewDeployed({ accessMode: "password", extraDomains: [] });
    const rel = await toLive();
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    const call = srv.callsOf("publish")[0]!;
    expect(call.args).toEqual([live.instanceName, String(live.port), "--auth", "--domain", live.domain, "--index"]);
    const pw = decryptSecret((await envRow(live.id))!.accessPasswordEnc!);
    expect(await bcrypt.compare(pw, call.stdin!.trim().split(":")[1]!)).toBe(true);
    expect(pub.publicCalls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`preview:${pw}`).toString("base64")}`);
  });

  it("refused when the commit never ran in the app's preview: nothing on the server, live untouched", async () => {
    const { ws, repo, live, toLive } = await previewDeployed();
    const sha2 = repo.commit({ "src/page.tsx": "v2, never previewed" }, "v2");
    const rel = await toLive({ commit: sha2, promotedFromReleaseId: null });
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", step: "prepare", error: expect.stringMatching(/never ran in this app's preview/) });
    expect(srv.calls).toEqual([]);
    expect(checkDomains).not.toHaveBeenCalled();
    expect(await envRow(live.id)).toMatchObject({ status: "new", currentReleaseId: null });
  });

  it("refused when the preview release it names is of another commit, or a failed preview is all there is", async () => {
    const { ws, repo, app, preview, toLive } = await previewDeployed();
    const sha2 = repo.commit({ "src/page.tsx": "v2" }, "v2");
    const mismatch = await toLive({ commit: sha2 });
    expect(await runRelease(mismatch.id, ws.id)).toBe("failed");
    expect((await releaseRow(mismatch.id)).error).toMatch(/ran commit .* not /);
    // a preview release of sha2 that failed does not count
    const failedPrev = await queueRelease(app, { environmentId: preview.id, commit: sha2, status: "failed" });
    const rel = await toLive({ commit: sha2, promotedFromReleaseId: failedPrev.id });
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/never ran in this app's preview/);
    expect(srv.calls).toEqual([]);
  });

  it.each([
    ["the domain points elsewhere", "wrong"],
    ["the domain has no record yet", "missing"],
    ["public DNS does not answer", "error"],
  ] as const)("refused when %s: the check is stored, nothing on the server", async (_n, status) => {
    const { ws, live, toLive } = await previewDeployed();
    const bad: DomainCheck = { status, expected: ["203.0.113.10"], names: [{ name: live.domain, status, found: status === "wrong" ? ["198.51.100.7"] : [] }], checkedAt: new Date().toISOString() };
    vi.mocked(checkDomains).mockResolvedValue(bad);
    const rel = await toLive();
    expect(await runRelease(rel.id, ws.id)).toBe("failed");
    const r = await releaseRow(rel.id);
    expect(r).toMatchObject({ status: "failed", step: "prepare" });
    expect(r.error).toMatch(new RegExp(`does not point at server dev yet \\(${status}`));
    expect(srv.calls).toEqual([]);
    expect(await envRow(live.id)).toMatchObject({ status: "new", dnsCheck: expect.objectContaining({ status }) });
  });

  it("refused unless an Owner started it, and never from a task or an approval", async () => {
    const { ws, user, app, live, prev } = await previewDeployed();
    const { members } = await import("@wfos/db");
    await db.update(members).set({ role: "ADMIN" }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, user.id)));
    const byAdmin = await queueRelease(app, { environmentId: live.id, commit: prev.commit, promotedFromReleaseId: prev.id, createdBy: user.id });
    expect(await runRelease(byAdmin.id, ws.id)).toBe("failed");
    expect((await releaseRow(byAdmin.id)).error).toMatch(/Only an Owner/);
    await db.update(members).set({ role: "OWNER" }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, user.id)));
    const byApproval = await queueRelease(app, { environmentId: live.id, commit: prev.commit, createdBy: user.id, trigger: "approval" });
    expect(await runRelease(byApproval.id, ws.id)).toBe("failed");
    expect((await releaseRow(byApproval.id)).error).toMatch(/A task cannot release to LIVE/);
    const noCommit = await queueRelease(app, { environmentId: live.id, createdBy: user.id });
    expect(await runRelease(noCommit.id, ws.id)).toBe("failed");
    expect((await releaseRow(noCommit.id)).error).toMatch(/names the commit/);
    expect(srv.calls).toEqual([]);
  });

  it("a second live release supersedes only live's previous release", async () => {
    const { ws, repo, app, preview, prev, toLive } = await previewDeployed();
    const first = await toLive();
    expect(await runRelease(first.id, ws.id)).toBe("deployed");
    const sha2 = repo.commit({ "src/page.tsx": "v2" }, "v2");
    const prev2 = await queueRelease(app, { environmentId: preview.id, createdBy: prev.createdBy });
    expect(await runRelease(prev2.id, ws.id)).toBe("deployed");
    const second = await toLive({ commit: sha2, promotedFromReleaseId: prev2.id });
    expect(await runRelease(second.id, ws.id)).toBe("deployed");
    expect(await releaseRow(first.id)).toMatchObject({ status: "superseded" });
    expect(await releaseRow(prev2.id)).toMatchObject({ status: "deployed" });
    expect(await releaseRow(prev.id)).toMatchObject({ status: "superseded" });
  });
});

describe("environment actions", () => {
  async function bothRunning() {
    const f = await previewDeployed();
    const rel = await f.toLive();
    expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
    srv.calls.length = 0;
    resetTransport();
    return { ...f, liveRel: rel };
  }

  it("stop / start / republish with environmentId act on that environment only", async () => {
    const { app, user, preview, live } = await bothRunning();
    expect(await runAppAction(job(app, "stop", { environmentId: live.id }))).toBe("done");
    expect(srv.calls.map((c) => [c.cmd, c.args[0]])).toEqual([["unit-stop", live.instanceName], ["unpublish", live.instanceName]]);
    expect(await envRow(live.id)).toMatchObject({ status: "stopped" });
    expect(await envRow(preview.id)).toMatchObject({ status: "running" });
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "start", { environmentId: live.id, userId: user.id }))).toBe("done");
    expect(srv.env).toContain(`SMTP_PASSWORD=${LIVE_ENV}\n`);
    expect(srv.callsOf("publish")[0]!.args).toEqual([live.instanceName, String(live.port), "--domain", live.domain, "--alias", `www.${live.domain}`, "--index"]);
    srv.calls.length = 0;
    // without environmentId: the preview (as before environments)
    expect(await runAppAction(job(app, "republish"))).toBe("done");
    expect(srv.callsOf("publish")[0]!.args).toEqual([preview.instanceName, String(preview.port), "--auth"]);
  });

  it("remove with environmentId removes only that environment (row and releases); without it, every environment and the app", async () => {
    const { app, preview, live, prev, liveRel } = await bothRunning();
    expect(await runAppAction(job(app, "remove", { environmentId: live.id }))).toBe("done");
    expect(srv.calls.map((c) => [c.cmd, ...c.args])).toEqual([["app-remove", live.instanceName, "--drop-db", "--keep-db-dump"]]);
    expect(await envRow(live.id)).toBeUndefined();
    expect(await db.select().from(appReleases).where(eq(appReleases.id, liveRel.id))).toEqual([]);
    expect(await envRow(preview.id)).toMatchObject({ status: "running" });
    expect(await releaseRow(prev.id)).toMatchObject({ status: "deployed" });
    expect((await db.select().from(apps).where(eq(apps.id, app.id))).length).toBe(1);

    const again = await makeLive(app, preview.serverId, { domain: `again-${live.domain}`, extraDomains: [] });
    srv.calls.length = 0;
    expect(await runAppAction(job(app, "remove"))).toBe("done");
    // live first, then the preview, then the app row
    expect(srv.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["app-remove", again.instanceName, "--drop-db", "--keep-db-dump"],
      ["app-remove", preview.instanceName, "--drop-db"],
    ]);
    expect(await db.select().from(apps).where(eq(apps.id, app.id))).toEqual([]);
    expect(await db.select().from(appEnvironments).where(eq(appEnvironments.appId, app.id))).toEqual([]);
    const actions = (await db.select().from(auditLog).where(eq(auditLog.targetId, app.id))).map((a) => a.action);
    expect(actions.filter((a) => a === "app.environment_removed")).toHaveLength(3);
    expect(actions).toContain("app.removed");
  });

  it("a whole-app remove that fails on one environment keeps the rest and the app", async () => {
    const { app, preview, live } = await bothRunning();
    srv.replies["app-remove"] = (c) => (c.args[0] === preview.instanceName ? { code: 1, stderr: "rm: busy\n" } : undefined);
    expect(await runAppAction(job(app, "remove"))).toBe("failed");
    expect(await envRow(live.id)).toBeUndefined();
    expect(await envRow(preview.id)).toMatchObject({ statusMessage: "remove_failed" });
    expect((await db.select().from(apps).where(eq(apps.id, app.id))).length).toBe(1);
  });

  it("an idle stop never touches live, even when queued for it", async () => {
    const { app, preview, live } = await bothRunning();
    await db.update(appEnvironments).set({ lastDeployedAt: daysAgo(30) }).where(eq(appEnvironments.appId, app.id));
    const out = await tickApps();
    expect(out.idle).toContain(preview.id);
    expect(out.idle).not.toContain(live.id);
    expect(await runAppAction(job(app, "stop", { environmentId: live.id, reason: "idle" }))).toBe("skipped");
    expect(srv.calls.filter((c) => c.args[0] === live.instanceName && c.cmd !== "health")).toEqual([]);
    expect(await envRow(live.id)).toMatchObject({ status: "running" });
  });

  it("health per environment: each instance on its port; live going down notifies with (LIVE), the preview stays healthy", async () => {
    const { app, ws, preview, live } = await bothRunning();
    await db.update(appEnvironments).set({ lastHealthAt: new Date(Date.now() - APP_HEALTH_EVERY_MS - 60_000) }).where(eq(appEnvironments.appId, app.id));
    srv.replies["health"] = (c) => (c.args[0] === live.instanceName ? { code: 1, stdout: '{"status":502}\n' } : undefined);
    const out = await tickApps();
    expect(out.health.filter((h) => h.appId === app.id).sort((a, b) => a.environmentId.localeCompare(b.environmentId))).toEqual(
      [
        { appId: app.id, environmentId: preview.id, healthy: true, wentDown: false },
        { appId: app.id, environmentId: live.id, healthy: false, wentDown: true },
      ].sort((a, b) => a.environmentId.localeCompare(b.environmentId)),
    );
    expect(srv.callsOf("health").map((c) => c.args).sort()).toEqual(
      [
        [preview.instanceName, String(preview.port), "/api/health"],
        [live.instanceName, String(live.port), "/api/health"],
      ].sort(),
    );
    expect(await envRow(live.id)).toMatchObject({ healthy: false });
    expect(await envRow(preview.id)).toMatchObject({ healthy: true });
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ notificationKind: "incident", subject: `${app.name} (LIVE) is not answering` })]);
    expect(transport.published.map((p) => p.ev as RealtimeEvent)).toContainEqual({ type: "app.updated", appId: app.id, status: "running", environmentId: live.id });
  });
});

describe("review fixes: live gates, rollback DNS, capacity, removal dump", () => {
  async function liveRunning(over: Parameters<typeof makeLive>[2] = {}) {
    const f = await previewDeployed(over);
    const rel = await f.toLive();
    expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
    srv.calls.length = 0;
    resetTransport();
    return { ...f, liveRel: rel };
  }
  const badDns = (status: DomainCheck["status"], name: string): DomainCheck => ({
    status,
    expected: ["203.0.113.10"],
    names: [{ name, status, found: status === "wrong" ? ["198.51.100.7"] : [] }],
    checkedAt: new Date().toISOString(),
  });

  it("the publish step records the names it published on the live release", async () => {
    const { live, liveRel } = await liveRunning();
    expect((await releaseRow(liveRel.id)).checkpoint).toMatchObject({ activated: true, publishedNames: [live.domain, `www.${live.domain}`] });
  });

  it("LIVE start: refused under the kill switch, in demo mode, without an Owner, and when DNS is not ok — nothing on the server", async () => {
    const { ws, user, app, live } = await liveRunning();
    const { workspaces, members } = await import("@wfos/db");
    expect(await runAppAction(job(app, "stop", { environmentId: live.id }))).toBe("done");
    srv.calls.length = 0;
    const start = (userId: string | null) => runAppAction(job(app, "start", { environmentId: live.id, userId }));

    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, ws.id));
    expect(await start(user.id)).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ status: "stopped", statusMessage: "kill_switch" });
    await db.update(workspaces).set({ killSwitch: false, demoMode: true }).where(eq(workspaces.id, ws.id));
    expect(await start(user.id)).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ statusMessage: "dry_run" });
    await db.update(workspaces).set({ demoMode: false }).where(eq(workspaces.id, ws.id));
    expect(await start(null)).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ statusMessage: "owner_required" });
    await db.update(members).set({ role: "ADMIN" }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, user.id)));
    expect(await start(user.id)).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ statusMessage: "owner_required" });
    await db.update(members).set({ role: "OWNER" }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, user.id)));
    vi.mocked(checkDomains).mockResolvedValue(badDns("wrong", live.domain));
    expect(await start(user.id)).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ status: "stopped", statusMessage: "dns_not_ok", dnsCheck: expect.objectContaining({ status: "wrong" }) });
    expect(srv.calls).toEqual([]);
    const audits = (await db.select().from(auditLog).where(and(eq(auditLog.targetId, app.id), eq(auditLog.action, "app.start_refused")))).map((r) => r.details.code);
    expect(audits.sort()).toEqual(["dns_not_ok", "dry_run", "kill_switch", "owner_required", "owner_required"]);

    vi.mocked(checkDomains).mockImplementation(async (names) => okDns(names));
    expect(await start(user.id)).toBe("done");
    expect(await envRow(live.id)).toMatchObject({ status: "running", statusMessage: null });
  });

  it("LIVE republish: Owner and DNS gates too; a successful one records the names on the running release", async () => {
    const { user, app, live, liveRel } = await liveRunning();
    expect(await runAppAction(job(app, "republish", { environmentId: live.id }))).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ status: "running", statusMessage: "owner_required" });
    vi.mocked(checkDomains).mockResolvedValue(badDns("missing", live.domain));
    expect(await runAppAction(job(app, "republish", { environmentId: live.id, userId: user.id }))).toBe("refused");
    expect(await envRow(live.id)).toMatchObject({ statusMessage: "dns_not_ok" });
    expect(srv.calls).toEqual([]);
    vi.mocked(checkDomains).mockImplementation(async (names) => okDns(names));
    // the Owner dropped the www alias (the site is republished with the new names)
    await db.update(appEnvironments).set({ extraDomains: [] }).where(eq(appEnvironments.id, live.id));
    expect(await runAppAction(job(app, "republish", { environmentId: live.id, userId: user.id }))).toBe("done");
    expect(srv.callsOf("publish")[0]!.args).toEqual([live.instanceName, String(live.port), "--domain", live.domain, "--index"]);
    expect((await releaseRow(liveRel.id)).checkpoint).toMatchObject({ publishedNames: [live.domain] });
  });

  it("LIVE rollback: a DNS lookup error does not block it while the site runs with unchanged names; wrong / missing / changed names still refuse", async () => {
    const { ws, user, app, repo, preview, live, prev, liveRel, toLive } = await liveRunning();
    // v2 through the preview to live, so there is something to roll back from
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    const prev2 = await queueRelease(app, { environmentId: preview.id, createdBy: user.id });
    expect(await runRelease(prev2.id, ws.id)).toBe("deployed");
    const second = await toLive({ commit: (await releaseRow(prev2.id)).commit, promotedFromReleaseId: prev2.id });
    expect(await runRelease(second.id, ws.id)).toBe("deployed");
    const rollback = () =>
      queueRelease(app, { environmentId: live.id, trigger: "rollback", rollbackOfId: liveRel.id, commit: prev.commit, branch: prev.branch, manifest: prev.manifest, createdBy: user.id });

    vi.mocked(checkDomains).mockResolvedValue(badDns("wrong", live.domain));
    const refusedWrong = await rollback();
    expect(await runRelease(refusedWrong.id, ws.id)).toBe("failed");
    expect((await releaseRow(refusedWrong.id)).error).toMatch(/does not point at server dev yet \(wrong/);
    vi.mocked(checkDomains).mockResolvedValue(badDns("missing", live.domain));
    const refusedMissing = await rollback();
    expect(await runRelease(refusedMissing.id, ws.id)).toBe("failed");

    vi.mocked(checkDomains).mockResolvedValue(badDns("error", live.domain));
    const rb = await rollback();
    expect(await runRelease(rb.id, ws.id)).toBe("deployed");
    expect((await releaseRow(rb.id)).log).toMatch(/public DNS did not answer, but the names are the ones .* published: the rollback goes on/);
    expect(await envRow(live.id)).toMatchObject({ status: "running", currentReleaseId: rb.id });

    // names changed since the running release published them: the error refuses again
    await db.update(appEnvironments).set({ extraDomains: [`shop.${live.domain}`] }).where(eq(appEnvironments.id, live.id));
    const changed = await queueRelease(app, { environmentId: live.id, trigger: "rollback", rollbackOfId: second.id, commit: second.commit, branch: second.branch, manifest: (await releaseRow(second.id)).manifest, createdBy: user.id });
    expect(await runRelease(changed.id, ws.id)).toBe("failed");
    expect((await releaseRow(changed.id)).error).toMatch(/\(error/);
    // a normal (non-rollback) live release is never exempt
    await db.update(appEnvironments).set({ extraDomains: [`www.${live.domain}`] }).where(eq(appEnvironments.id, live.id));
    const normal = await toLive({ commit: (await releaseRow(prev2.id)).commit, promotedFromReleaseId: prev2.id });
    expect(await runRelease(normal.id, ws.id)).toBe("failed");
  });

  it("capacity: previews filling maxRunningApps never block a live deploy or start; live does not take a preview slot", async () => {
    const repo = makeRemote();
    const f = await makeApp({ remote: repo.remote, role: "OWNER", server: { maxRunningApps: 1 } });
    const prev = await queueRelease(f.app, { createdBy: f.user.id });
    expect(await runRelease(prev.id, f.ws.id)).toBe("deployed"); // the one preview slot is taken
    const live = await makeLive(f.app, f.server.id);
    const rel = await queueRelease(f.app, { environmentId: live.id, commit: (await releaseRow(prev.id)).commit, promotedFromReleaseId: prev.id, createdBy: f.user.id });
    expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
    expect(await runAppAction(job(f.app, "stop", { environmentId: live.id }))).toBe("done");
    expect(await runAppAction(job(f.app, "start", { environmentId: live.id, userId: f.user.id }))).toBe("done");
    // the preview stopped and started again: the running live environment does not count against it
    expect(await runAppAction(job(f.app, "stop"))).toBe("done");
    expect(await runAppAction(job(f.app, "start"))).toBe("done");
    expect(await envRow(f.preview.id)).toMatchObject({ status: "running" });
  });

  it("removing LIVE keeps a database dump: --keep-db-dump, the path in the audit entries and a notification", async () => {
    const { ws, user, app, live } = await liveRunning();
    expect(await runAppAction(job(app, "remove", { environmentId: live.id, userId: user.id }))).toBe("done");
    const path = `/var/lib/wfos-apps/removed/${live.instanceName}-20261014T033000Z.dump`;
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, app.id), eq(auditLog.action, "app.environment_removed")));
    expect(entry!.details).toMatchObject({ environmentId: live.id, environment: "live", dbDump: path });
    expect(notifications(ws.id)).toEqual([expect.objectContaining({ userId: user.id, subject: `LIVE removed: ${app.name}`, text: expect.stringContaining(path) })]);

    // the whole app: the live dump path in app.removed too; the preview is removed without a dump
    const again = await makeLive(app, live.serverId, { domain: `again-${live.domain}`, extraDomains: [] });
    expect(await runAppAction(job(app, "remove"))).toBe("done");
    const [removed] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, app.id), eq(auditLog.action, "app.removed")));
    expect(removed!.details.environments).toEqual([
      { id: again.id, kind: "live", domain: again.domain, dbDump: `/var/lib/wfos-apps/removed/${again.instanceName}-20261014T033000Z.dump` },
      expect.objectContaining({ kind: "preview", dbDump: null }),
    ]);
  });
});
