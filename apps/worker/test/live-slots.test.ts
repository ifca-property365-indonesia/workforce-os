import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appBackups, appEnvironments, appReleases, auditLog, db, members } from "@wfos/db";
import { APP_ALT_PORT_OFFSET, APP_LIVE_GRACE_SECONDS, type DeployJob, type NotifyJob } from "@wfos/shared";
import { checkDomains } from "@wfos/shared/dns";
import { runAppAction } from "../src/deploy/actions";
import { recoverInterruptedRestores, runDbJob } from "../src/deploy/backups";
import type { LiveCheckpoint } from "../src/deploy/common";
import type { SlotStopJob } from "../src/deploy/jobs";
import { runRelease, settleInterrupted } from "../src/deploy/pipeline";
import { runSlotStop, sweepGraceStops } from "../src/deploy/slots";
import { expandViolationsIn, expandViolationsOf } from "../src/deploy/manifest";
import { deploysQueue } from "../src/lib/redis";
import { tickApps } from "../src/scheduler/apps";
import { FakeServer, fastDeploys, makeApp, makeLive, makeRemote, MANIFEST, okDns, queueRelease } from "./deploy-fixtures";
import { resetTransport, transport } from "./transport";

// Phase B2: live blue-green slots, maintenance page, backups. SSH is FakeServer (helper v4), DNS is mocked.
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

const envRow = async (id: string) => (await db.select().from(appEnvironments).where(eq(appEnvironments.id, id)))[0]!;
const releaseRow = async (id: string) => (await db.select().from(appReleases).where(eq(appReleases.id, id)))[0]!;
const cp = async (id: string) => (await releaseRow(id)).checkpoint as LiveCheckpoint;
const notifications = (workspaceId: string) => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob).filter((n) => n.workspaceId === workspaceId);
const graceJobs = () => transport.queued.filter((q) => q.queue === "deploys" && q.name === "slot_stop");
const EXPAND = JSON.stringify({ ...MANIFEST, migrations: "expand" });

/**
 * Helper calls in order, compactly: unit/release commands with their slot (`unit-restart@green`), publish with its
 * port (`publish:4108`, `+m` = maintenance page), health with its port; repeated health polls collapse into one.
 */
function steps(): string[] {
  const out: string[] = [];
  for (const c of srv.calls) {
    const slot = FakeServer.slotOf(c);
    let name = c.cmd === "build-run" ? `build-run:${c.args[2]}` : c.cmd;
    if (slot) name += `@${slot}`;
    if (c.cmd === "publish") name = `publish:${c.args[1]}${c.args.includes("--maintenance") ? "+m" : ""}`;
    if (c.cmd === "health") name = `health:${c.args[1]}`;
    if (out[out.length - 1] === name && c.cmd === "health") continue;
    out.push(name);
  }
  return out;
}

/** An Owner's app: preview runs v1, LIVE runs v1 in slot blue (its first release). */
async function liveOnBlue(o: { manifest?: string } = {}) {
  const repo = makeRemote(o.manifest ? { "wfos-app.json": o.manifest } : {});
  const f = await makeApp({ remote: repo.remote, role: "OWNER" });
  const prev = await queueRelease(f.app, { createdBy: f.user.id });
  expect(await runRelease(prev.id, f.ws.id)).toBe("deployed");
  const live = await makeLive(f.app, f.server.id);
  const prevRow = await releaseRow(prev.id);
  const first = await queueRelease(f.app, { environmentId: live.id, commit: prevRow.commit, promotedFromReleaseId: prev.id, createdBy: f.user.id });
  expect(await runRelease(first.id, f.ws.id)).toBe("deployed");
  /** commit files, deploy them to the preview, queue their LIVE release */
  const promote = async (files: Record<string, string | null>) => {
    repo.commit(files, "next");
    const p = await queueRelease(f.app, { environmentId: f.preview.id, createdBy: f.user.id });
    expect(await runRelease(p.id, f.ws.id)).toBe("deployed");
    const pr = await releaseRow(p.id);
    reset();
    return queueRelease(f.app, { environmentId: live.id, commit: pr.commit, promotedFromReleaseId: p.id, createdBy: f.user.id });
  };
  const reset = () => {
    srv.calls.length = 0;
    pub.publicCalls.length = 0;
    resetTransport();
  };
  reset();
  const blue = live.port;
  const green = live.port + APP_ALT_PORT_OFFSET;
  const inst = live.instanceName;
  return { ...f, repo, live, inst, first: await releaseRow(first.id), blue, green, promote, reset };
}

/** a change whose migration only adds */
const addColumn = (m = EXPAND) => ({ "wfos-app.json": m, "prisma/migrations/0002_note/migration.sql": "ALTER TABLE orders ADD COLUMN note text;\n" });
/** a change whose migration renames */
const renameColumn = (m = MANIFEST_BREAKING) => ({ "wfos-app.json": m, "prisma/migrations/0002_rename/migration.sql": "ALTER TABLE orders RENAME COLUMN id TO order_id;\n" });
const MANIFEST_BREAKING = JSON.stringify({ ...MANIFEST, migrations: "breaking" });

describe("live release: expand", () => {
  it("builds and migrates while the old slot serves, starts green on its port, switches, keeps blue for the grace time", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    let blueDuringMigrate: string | undefined;
    srv.replies["build-run:migrate"] = () => {
      blueDuringMigrate = srv.slotUnit(f.inst, "blue")?.state;
      return { code: 0 };
    };
    const rel = await f.promote(addColumn());
    expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
    const backup = (await releaseRow(rel.id)).dbBackup!;
    expect(backup).toMatch(/^pre-migrate-\d{8}T\d{6}Z$/);
    expect(steps()).toEqual([
      "app-init",
      "release-unpack",
      "env-install",
      "db-create",
      "build-run:install",
      "build-run:build",
      "db-dump",
      "db-backups",
      "build-run:migrate",
      "release-activate@green",
      "unit-install@green",
      "unit-restart@green",
      `health:${f.green}`,
      `publish:${f.green}`,
      "release-prune",
    ]);
    expect(blueDuringMigrate).toBe("active");
    expect(srv.callsOf("db-dump")[0]!.args).toEqual([f.inst, backup, "--keep-kind", "pre-migrate-", "7"]);
    expect(srv.callsOf("unit-install")[0]!.args).toEqual([f.inst, String(f.green), "512", "--database", "--slot", "green"]);
    expect(srv.site.get(f.inst)).toEqual({ port: f.green, maintenance: false });
    // the old slot still runs (instant rollback) and is stopped later by a delayed job
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("active");
    expect(graceJobs()).toEqual([
      expect.objectContaining({ data: { kind: "slot_stop", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, releaseId: rel.id, slot: "blue" }, opts: expect.objectContaining({ delay: APP_LIVE_GRACE_SECONDS * 1000, jobId: `slot_stop-${rel.id}-blue`, removeOnComplete: true, removeOnFail: true }) }),
    ]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "green", maintenance: false, currentReleaseId: rel.id });
    expect(await cp(rel.id)).toMatchObject({ slot: "green", previousSlot: "blue", graceSlot: "blue", graceReleaseId: f.first.id, graceDone: false, migrated: true });
    const [row] = await db.select().from(appBackups).where(and(eq(appBackups.environmentId, f.live.id), eq(appBackups.name, backup)));
    expect(row).toMatchObject({ kind: "pre_migrate", releaseId: rel.id, sizeBytes: 4321, deletedAt: null });
  });

  it("refused when it claims expand but a migration renames: the file and statement named, nothing on the server", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const rel = await f.promote(renameColumn(EXPAND));
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    const r = await releaseRow(rel.id);
    expect(r.error).toMatch(/claims "migrations": "expand" but prisma\/migrations\/0002_rename\/migration\.sql contains RENAME: ALTER TABLE orders RENAME COLUMN id TO order_id/);
    expect(srv.calls).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "blue", currentReleaseId: f.first.id });
  });

  it.each([
    ["migrate", "failed"],
    ["health", "failed"],
    ["public_check", "rolled_back"],
  ] as const)("a failure at %s: blue keeps serving, green stopped, the database is not restored", async (stage, status) => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const rel = await f.promote(addColumn());
    if (stage === "migrate") srv.replies["build-run:migrate"] = { code: 1, stderr: "migration failed\n" };
    if (stage === "health") srv.healthy = (sha) => sha !== rel.commit;
    if (stage === "public_check") pub.setPublicStatus(502);
    expect(await runRelease(rel.id, f.ws.id)).toBe(status);
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("active");
    expect(srv.slotUnit(f.inst, "green")?.state ?? "inactive").toBe("inactive");
    expect(srv.callsOf("db-restore")).toEqual([]);
    expect(srv.callsOf("unit-stop").map((c) => c.args)).toEqual(stage === "migrate" ? [] : [[f.inst, "--slot", "green"]]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "blue", maintenance: false, currentReleaseId: f.first.id });
    if (stage === "public_check") expect(steps().slice(steps().indexOf(`publish:${f.green}`))).toEqual([`publish:${f.green}`, `publish:${f.blue}`, "unit-stop@green", "env-install"]);
    expect(graceJobs()).toEqual([]);
  });

  it("a backup that fails refuses the release: nothing switched, nothing stopped", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const rel = await f.promote(addColumn());
    srv.replies["db-dump"] = { code: 1, stderr: "pg_dump: error\n" };
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/database backup failed, so the release is refused/);
    expect(srv.callsOf("build-run").map((c) => c.args[2])).not.toContain("migrate");
    expect(srv.callsOf("unit-stop")).toEqual([]);
    expect(srv.callsOf("publish")).toEqual([]);
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "blue" });
  });
});

describe("live release: breaking", () => {
  it("maintenance page, old slot stopped, backup, migrate, green started, switch: no grace (the old one is stopped)", async () => {
    const f = await liveOnBlue();
    let duringMigrate: { site?: unknown; blue?: string } = {};
    srv.replies["build-run:migrate"] = () => {
      duringMigrate = { site: { ...srv.site.get(f.inst) }, blue: srv.slotUnit(f.inst, "blue")?.state };
      return { code: 0 };
    };
    const rel = await f.promote(renameColumn());
    expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
    const s = steps();
    expect(s.slice(s.indexOf("build-run:build"))).toEqual([
      "build-run:build",
      `publish:${f.blue}+m`,
      "unit-stop@blue",
      "db-dump",
      "db-backups",
      "build-run:migrate",
      "release-activate@green",
      "unit-install@green",
      "unit-restart@green",
      `health:${f.green}`,
      `publish:${f.green}`,
      "release-prune",
    ]);
    expect(duringMigrate).toEqual({ site: { port: f.blue, maintenance: true }, blue: "inactive" });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "green", maintenance: false });
    expect(graceJobs()).toEqual([]);
    expect(await cp(rel.id)).toMatchObject({ maintenance: true, graceSlot: null, graceDone: true });
  });

  it.each([
    ["backup", "failed", false],
    ["migrate", "failed", true],
    ["health", "failed", true],
    ["public_check", "rolled_back", true],
  ] as const)("a failure at %s: database restored when it migrated, blue started again, maintenance off", async (stage, status, restored) => {
    const f = await liveOnBlue();
    const rel = await f.promote(renameColumn());
    if (stage === "backup") srv.replies["db-dump"] = { code: 1, stderr: "pg_dump: error\n" };
    if (stage === "migrate") srv.replies["build-run:migrate"] = { code: 1, stderr: "migration failed\n" };
    if (stage === "health") srv.healthy = (sha) => sha !== rel.commit;
    if (stage === "public_check") pub.setPublicStatus(502);
    expect(await runRelease(rel.id, f.ws.id)).toBe(status);
    const r = await releaseRow(rel.id);
    expect(srv.callsOf("db-restore").map((c) => c.args)).toEqual(restored ? [[f.inst, r.dbBackup!]] : []);
    expect(srv.restoredUnderRunningApp).toEqual([]);
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("active");
    expect(srv.slotUnit(f.inst, "green")?.state ?? "inactive").toBe("inactive");
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "blue", maintenance: false, currentReleaseId: f.first.id });
    const s = steps();
    expect(s.slice(s.lastIndexOf("unit-start@blue"))).toEqual(["unit-start@blue", `health:${f.blue}`, `publish:${f.blue}`]);
    if (stage === "public_check") expect(s.slice(s.indexOf(`publish:${f.green}`), s.indexOf("unit-start@blue"))).toEqual([`publish:${f.green}`, `publish:${f.blue}+m`, "unit-stop@green", "db-restore", "env-install"]);
  });

  it("when the old version does not come back either: maintenance page stays, LIVE failed, every Owner told", async () => {
    const f = await liveOnBlue();
    const { users } = await import("@wfos/db");
    const [owner2] = await db.insert(users).values({ email: `owner2-${f.app.slug}@test.local`, name: "O2", passwordHash: "x" }).returning();
    await db.insert(members).values({ workspaceId: f.ws.id, userId: owner2!.id, role: "OWNER" });
    const rel = await f.promote(renameColumn());
    srv.healthy = () => false;
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: true });
    expect(await envRow(f.live.id)).toMatchObject({ status: "failed", maintenance: true, statusMessage: "rollback_failed" });
    const attention = notifications(f.ws.id).filter((n) => n.subject.startsWith("LIVE needs attention"));
    expect(attention.map((n) => n.userId).sort()).toEqual([f.user.id, owner2!.id].sort());
    expect(attention[0]!.text).toMatch(/maintenance page/);
    expect(srv.restoredUnderRunningApp).toEqual([]);
  });
});

describe("live release: nothing served before", () => {
  it("a first live release that fails its public check: failed (not rolled back), unpublished, slot stopped", async () => {
    const repo = makeRemote();
    const f = await makeApp({ remote: repo.remote, role: "OWNER" });
    const prev = await queueRelease(f.app, { createdBy: f.user.id });
    expect(await runRelease(prev.id, f.ws.id)).toBe("deployed");
    const live = await makeLive(f.app, f.server.id);
    pub.setPublicStatus(503);
    const rel = await queueRelease(f.app, { environmentId: live.id, commit: (await releaseRow(prev.id)).commit, promotedFromReleaseId: prev.id, createdBy: f.user.id });
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    expect(srv.site.get(live.instanceName)).toBeUndefined();
    expect(srv.slotUnit(live.instanceName, "blue")?.state).toBe("inactive");
    expect(await envRow(live.id)).toMatchObject({ status: "failed", currentReleaseId: null, maintenance: false });
  });

  it("a release of a stopped LIVE: goes to the idle slot, the stopped old one stays stopped, no grace", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    expect(await runAppAction({ kind: "app_action", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, action: "stop", userId: f.user.id })).toBe("done");
    const rel = await f.promote(addColumn());
    expect(await runRelease(rel.id, f.ws.id)).toBe("deployed");
    expect(srv.site.get(f.inst)).toEqual({ port: f.green, maintenance: false });
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("inactive");
    expect(graceJobs()).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "green" });
  });
});

describe("live rollback", () => {
  it("in the grace time: nginx goes straight back to the old slot (no build, no activate), and the left slot gets its grace", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    f.reset();
    const rb = await queueRelease(f.app, { environmentId: f.live.id, trigger: "rollback", rollbackOfId: f.first.id, commit: f.first.commit, branch: "main", manifest: f.first.manifest, createdBy: f.user.id });
    expect(await runRelease(rb.id, f.ws.id)).toBe("deployed");
    expect(steps()).toEqual(["unit-status@blue", `health:${f.blue}`, `publish:${f.blue}`, "env-install"]);
    expect(srv.callsOf("db-restore")).toEqual([]);
    expect(srv.callsOf("db-dump")).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ activeSlot: "blue", currentReleaseId: rb.id, status: "running" });
    expect(await cp(rb.id)).toMatchObject({ slot: "blue", graceSlot: "green", graceReleaseId: v2.id });
    expect(graceJobs().map((j) => (j.data as SlotStopJob).slot)).toEqual(["green"]);
    // v2's own grace job finds another release running and does nothing
    expect(await runSlotStop({ kind: "slot_stop", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, releaseId: v2.id, slot: "blue" })).toBe("skipped");
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("active");
  });

  it("after the grace time: the old release is activated in the idle slot from its folder (no rebuild), health, switch", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    const job = graceJobs()[0]!.data as SlotStopJob;
    expect(await runSlotStop(job)).toBe("done");
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("inactive");
    expect(await cp(v2.id)).toMatchObject({ graceDone: true });
    f.reset();
    const rb = await queueRelease(f.app, { environmentId: f.live.id, trigger: "rollback", rollbackOfId: f.first.id, commit: f.first.commit, branch: "main", manifest: f.first.manifest, createdBy: f.user.id });
    expect(await runRelease(rb.id, f.ws.id)).toBe("deployed");
    expect(steps()).toEqual([
      "db-dump",
      "db-backups",
      "env-install",
      "release-activate@blue",
      "unit-install@blue",
      "unit-restart@blue",
      `health:${f.blue}`,
      `publish:${f.blue}`,
      "release-prune",
    ]);
    expect(srv.callsOf("build-run")).toEqual([]);
    expect(srv.callsOf("db-restore")).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ activeSlot: "blue", currentReleaseId: rb.id });
    expect(graceJobs().map((j) => (j.data as SlotStopJob).slot)).toEqual(["green"]);
  });
});

describe("grace stop", () => {
  it("survives a worker restart: a lost job is queued again from the checkpoint, then stops the old slot once", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    const until = Date.parse((await cp(v2.id)).graceUntil!);
    const q = deploysQueue as unknown as { getJobs?: () => Promise<unknown[]> };
    // the delayed job is still in Redis after the restart: nothing queued again
    const pending = graceJobs()[0]!.data;
    q.getJobs = async () => [{ data: pending, timestamp: Date.now(), opts: { delay: APP_LIVE_GRACE_SECONDS * 1000 } }];
    try {
      resetTransport();
      expect(await sweepGraceStops(Date.now())).not.toContain(v2.id);
      // Redis lost it (or it died while active): queued again, due now
      q.getJobs = async () => [];
      expect(await sweepGraceStops(until + 5000)).toContain(v2.id);
    } finally {
      delete q.getJobs;
    }
    const again = graceJobs().find((j) => (j.data as SlotStopJob).releaseId === v2.id)!;
    expect(again.opts?.delay).toBe(0);
    expect(await runSlotStop(again.data as SlotStopJob)).toBe("done");
    expect(srv.callsOf("unit-stop").map((c) => c.args)).toEqual([[f.inst, "--slot", "blue"]]);
    expect(await runSlotStop(again.data as SlotStopJob)).toBe("skipped");
    expect(await sweepGraceStops(until + 60 * 60_000)).not.toContain(v2.id);
  });

  it("an unreachable server leaves it pending (tried again), a stop of LIVE ends the grace too", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    const job = graceJobs()[0]!.data as SlotStopJob;
    srv.unreachable = true;
    expect(await runSlotStop(job)).toBe("failed");
    expect(await cp(v2.id)).toMatchObject({ graceDone: false });
    srv.unreachable = false;
    srv.calls.length = 0;
    expect(await runAppAction({ kind: "app_action", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, action: "stop", userId: f.user.id })).toBe("done");
    expect(steps()).toEqual(["unit-stop@green", "unit-stop@blue", "unpublish"]);
    expect(await cp(v2.id)).toMatchObject({ graceDone: true });
    // start: the current release's slot, on its port
    srv.calls.length = 0;
    expect(await runAppAction({ kind: "app_action", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, action: "start", userId: f.user.id })).toBe("done");
    expect(steps()).toEqual(["env-install", "unit-install@green", "unit-start@green", `health:${f.green}`, `publish:${f.green}`]);
    expect(srv.callsOf("unit-install")[0]!.args).toEqual([f.inst, String(f.green), "512", "--database", "--slot", "green"]);
  });
});

describe("the first slotted release of a B1 live environment", () => {
  /** LIVE as B1 left it: one unit (no --slot), `current` → v1, on the environment's port; release without a slot */
  async function b1Live() {
    const f = await liveOnBlue({ manifest: EXPAND });
    // rewrite what the first (slotted) release did into the B1 shape
    const { slot: _s, previousSlot: _p, graceSlot: _g, graceReleaseId: _r, graceUntil: _u, graceDone: _d, ...b1cp } = f.first.checkpoint as LiveCheckpoint;
    await db.update(appReleases).set({ checkpoint: b1cp }).where(eq(appReleases.id, f.first.id));
    srv.slotLinks.clear();
    srv.slotUnits.clear();
    srv.currentOf.set(f.inst, f.first.commit);
    srv.current = f.first.commit;
    srv.singlePort.set(f.inst, f.blue);
    srv.singleState.set(f.inst, "active");
    srv.site.set(f.inst, { port: f.blue, maintenance: false });
    return f;
  }

  it("goes to green while the B1 unit serves; after the grace the B1 unit is stopped (no --slot); the next release takes blue", async () => {
    const f = await b1Live();
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    const s = steps();
    expect(s.slice(s.indexOf("release-activate@green"))).toEqual(["release-activate@green", "unit-install@green", "unit-restart@green", `health:${f.green}`, `publish:${f.green}`, "release-prune"]);
    expect(srv.singleState.get(f.inst)).toBe("active"); // the B1 unit keeps running for the grace time
    expect(await cp(v2.id)).toMatchObject({ slot: "green", previousSlot: null, graceSlot: "legacy" });
    const job = graceJobs()[0]!.data as SlotStopJob;
    expect(job.slot).toBe("legacy");
    srv.calls.length = 0;
    expect(await runSlotStop(job)).toBe("done");
    expect(srv.calls.map((c) => [c.cmd, ...c.args])).toEqual([["unit-stop", f.inst]]);
    expect(srv.singleState.get(f.inst)).toBe("inactive");

    const v3 = await f.promote({ "src/page.tsx": "v3" });
    expect(await runRelease(v3.id, f.ws.id)).toBe("deployed");
    expect(steps()).toContain("release-activate@blue");
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ activeSlot: "blue", currentReleaseId: v3.id });
  });

  it("an instant rollback to the B1 version during the grace, and a release into blue while the B1 unit still holds its port", async () => {
    const f = await b1Live();
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    // a release right away (grace not over): blue's port is freed from the B1 unit first
    const v3 = await f.promote({ "src/page.tsx": "v3" });
    expect(await runRelease(v3.id, f.ws.id)).toBe("deployed");
    const s = steps();
    expect(s.slice(s.indexOf("build-run:migrate") + 1, s.indexOf("unit-install@blue"))).toEqual(["unit-stop", "release-activate@blue"]);
    expect(await cp(v2.id)).toMatchObject({ graceDone: true });

    // and the instant way back to B1, on a fresh B1 environment
    const g = await b1Live();
    const w2 = await g.promote(addColumn());
    expect(await runRelease(w2.id, g.ws.id)).toBe("deployed");
    g.reset();
    const rb = await queueRelease(g.app, { environmentId: g.live.id, trigger: "rollback", rollbackOfId: g.first.id, commit: g.first.commit, branch: "main", manifest: g.first.manifest, createdBy: g.user.id });
    expect(await runRelease(rb.id, g.ws.id)).toBe("deployed");
    expect(steps()).toEqual(["unit-status", `health:${g.blue}`, `publish:${g.blue}`, "env-install"]);
    expect((await cp(rb.id)).slot).toBeUndefined(); // runs in the B1 unit again
    expect(await envRow(g.live.id)).toMatchObject({ activeSlot: "blue", currentReleaseId: rb.id });
    expect(graceJobs().map((j) => (j.data as SlotStopJob).slot)).toEqual(["green"]);
  });
});

describe("interrupted live releases (worker restart)", () => {
  it("cut after the switch, nginx on its own slot and it answers: finished as deployed (cleanup again), never undone", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    // what the dead worker left: deploying at public_check, nginx on green
    await db.update(appReleases).set({ status: "deploying", step: "public_check", finishedAt: null }).where(eq(appReleases.id, v2.id));
    await db.update(appEnvironments).set({ status: "deploying", activeSlot: "blue", currentReleaseId: f.first.id }).where(eq(appEnvironments.id, f.live.id));
    expect(srv.site.get(f.inst)).toEqual({ port: f.green, maintenance: false });
    srv.calls.length = 0;
    resetTransport();
    expect(await settleInterrupted(await releaseRow(v2.id))).toBe("deployed");
    expect(steps()).toEqual(["unit-status", "slots", `health:${f.green}`, "release-prune"]);
    expect(srv.site.get(f.inst)).toEqual({ port: f.green, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "green", maintenance: false, currentReleaseId: v2.id });
    // blue still runs: it gets its grace stop
    expect(graceJobs().map((j) => (j.data as SlotStopJob).slot)).toEqual(["blue"]);
  });

  it("breaking, cut during the migration: database restored with nothing running, blue started, maintenance off", async () => {
    const f = await liveOnBlue();
    const v2 = await f.promote(renameColumn());
    srv.replies["build-run:migrate"] = { code: 1, stderr: "killed\n" };
    expect(await runRelease(v2.id, f.ws.id)).toBe("failed");
    const r = await releaseRow(v2.id);
    // the state at the cut: maintenance on, blue stopped, migrating
    await db.update(appReleases).set({ status: "deploying", step: "migrate", finishedAt: null }).where(eq(appReleases.id, v2.id));
    await db.update(appEnvironments).set({ status: "deploying", maintenance: true }).where(eq(appEnvironments.id, f.live.id));
    srv.site.set(f.inst, { port: f.blue, maintenance: true });
    srv.slotUnits.get(`${f.inst}:blue`)!.state = "inactive";
    srv.calls.length = 0;
    expect(await settleInterrupted(await releaseRow(v2.id))).toBe("failed");
    expect(steps()).toEqual(["unit-status", "slots", "db-restore", "env-install", "unit-start@blue", `health:${f.blue}`, `publish:${f.blue}`]);
    expect(srv.callsOf("db-restore")[0]!.args).toEqual([f.inst, r.dbBackup!]);
    expect(srv.restoredUnderRunningApp).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", maintenance: false, activeSlot: "blue" });
  });

  it("the server's own view wins: cut at the health step, nginx already on green but it does not answer → back to blue", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    await db.update(appReleases).set({ status: "deploying", step: "health", finishedAt: null }).where(eq(appReleases.id, v2.id));
    await db.update(appEnvironments).set({ status: "deploying", currentReleaseId: f.first.id }).where(eq(appEnvironments.id, f.live.id));
    expect(srv.site.get(f.inst)).toEqual({ port: f.green, maintenance: false });
    srv.healthy = (sha) => sha !== v2.commit;
    srv.calls.length = 0;
    expect(await settleInterrupted(await releaseRow(v2.id))).toBe("rolled_back");
    expect(steps().slice(0, 5)).toEqual(["unit-status", "slots", `health:${f.green}`, `publish:${f.blue}`, "unit-stop@green"]);
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "blue", maintenance: false });
  });

  it("server unreachable: LIVE marked interrupted and the Owners told", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    await db.update(appReleases).set({ status: "deploying", step: "publish", finishedAt: null }).where(eq(appReleases.id, v2.id));
    await db.update(appEnvironments).set({ status: "deploying", currentReleaseId: f.first.id }).where(eq(appEnvironments.id, f.live.id));
    resetTransport();
    srv.unreachable = true;
    expect(await settleInterrupted(await releaseRow(v2.id))).toBe("failed");
    expect(await envRow(f.live.id)).toMatchObject({ status: "failed", statusMessage: "interrupted" });
    expect(notifications(f.ws.id).filter((n) => n.subject.startsWith("LIVE needs attention")).map((n) => n.userId)).toEqual([f.user.id]);
  });
});

describe("backups and restore", () => {
  const backupJob = (f: { app: { id: string }; ws: { id: string }; live: { id: string } }, userId: string | null, backupKind: "manual" | "daily") =>
    ({ kind: "db_backup", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, userId, backupKind }) as Extract<DeployJob, { kind: "db_backup" }>;
  const restoreJob = (f: { app: { id: string }; ws: { id: string }; live: { id: string } }, userId: string, backupId: string) =>
    ({ kind: "db_restore", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, userId, backupId }) as Extract<DeployJob, { kind: "db_restore" }>;
  const backupsOf = (envId: string) => db.select().from(appBackups).where(eq(appBackups.environmentId, envId));

  it("a manual backup: db-dump with its kind's pruning, a row with size and author; pruned ones get deletedAt", async () => {
    const f = await liveOnBlue();
    expect(await runDbJob(backupJob(f, f.user.id, "manual"))).toBe("done");
    const call = srv.callsOf("db-dump")[0]!;
    expect(call.args).toEqual([f.inst, expect.stringMatching(/^manual-\d{8}T\d{6}Z$/), "--keep-kind", "manual-", "7"]);
    const rows = await backupsOf(f.live.id);
    expect(rows).toEqual([expect.objectContaining({ name: call.args[1], kind: "manual", sizeBytes: 4321, createdBy: f.user.id, offsite: false, deletedAt: null })]);
    expect(await envRow(f.live.id)).toMatchObject({ lastBackupAt: null });

    // daily: 14 kept; the 15th prunes the oldest on the server and its row is marked
    const old = Array.from({ length: 14 }, (_, i) => `daily-2026090${String(i).padStart(2, "0")}T000000Z`.replace("2026090", "202609"));
    for (const [i, name] of old.entries()) {
      srv.backups.add(name);
      await db.insert(appBackups).values({ environmentId: f.live.id, workspaceId: f.ws.id, name, kind: "daily", createdAt: new Date(Date.now() - (20 - i) * 86_400_000) });
    }
    expect(await runDbJob(backupJob(f, null, "daily"))).toBe("done");
    const after = await backupsOf(f.live.id);
    expect(after.filter((b) => b.deletedAt).map((b) => b.name)).toEqual([old[0]]);
    expect(after.filter((b) => b.kind === "daily" && !b.deletedAt)).toHaveLength(14);
    expect((await envRow(f.live.id)).lastBackupAt).not.toBeNull();
    expect(transport.published.map((p) => p.ev)).toContainEqual(expect.objectContaining({ type: "app.updated", environmentId: f.live.id }));
  });

  it("restore: pre_restore backup, maintenance page, every unit stopped (grace too), db-restore, started, page off", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn()); // blue still runs its grace time
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    const target = (await backupsOf(f.live.id)).find((b) => b.kind === "pre_migrate")!;
    f.reset();
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("done");
    // the page and the stops first: the pre_restore dump is taken with nothing writing
    expect(steps()).toEqual([`publish:${f.green}+m`, "unit-stop@green", "unit-stop@blue", "db-dump", "db-backups", "db-restore", "unit-start@green", `health:${f.green}`, `publish:${f.green}`]);
    expect(srv.callsOf("db-dump")[0]!.args[1]).toMatch(/^pre-restore-/);
    expect(srv.callsOf("db-restore")[0]!.args).toEqual([f.inst, target.name]);
    expect(srv.restoredUnderRunningApp).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", maintenance: false, statusMessage: null });
    expect(await cp(v2.id)).toMatchObject({ graceDone: true });
    expect((await backupsOf(f.live.id)).some((b) => b.kind === "pre_restore")).toBe(true);
    expect(notifications(f.ws.id)).toEqual([expect.objectContaining({ userId: f.user.id, subject: expect.stringMatching(/^Database restored/) })]);
    const audits = (await db.select().from(auditLog).where(and(eq(auditLog.targetId, f.app.id), eq(auditLog.action, "app.restored")))).map((a) => a.details);
    expect(audits).toEqual([expect.objectContaining({ backupId: target.id, environmentId: f.live.id })]);
  });

  it("restore that fails: the pre_restore backup goes back (nothing running), the app runs again, restore_failed, Owners told", async () => {
    const f = await liveOnBlue();
    expect(await runDbJob(backupJob(f, f.user.id, "manual"))).toBe("done");
    const target = (await backupsOf(f.live.id))[0]!;
    f.reset();
    srv.replies["db-restore"] = (c) => (c.args[1] === target.name ? { code: 1, stderr: "pg_restore: error\n" } : undefined);
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("failed");
    const restores = srv.callsOf("db-restore").map((c) => c.args[1]);
    expect(restores[0]).toBe(target.name);
    expect(restores[1]).toMatch(/^pre-restore-/);
    expect(srv.restoredUnderRunningApp).toEqual([]);
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", maintenance: false, statusMessage: "restore_failed" });
    expect(notifications(f.ws.id)).toEqual([expect.objectContaining({ notificationKind: "incident", userId: f.user.id, subject: expect.stringMatching(/^Database restore failed/), text: expect.stringMatching(/put back as it was before the restore and the app runs again/) })]);

    // and when the app still fails afterwards: the maintenance page stays
    f.reset();
    delete srv.replies["db-restore"];
    srv.healthy = () => false;
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("failed");
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: true });
    expect(await envRow(f.live.id)).toMatchObject({ status: "failed", maintenance: true, statusMessage: "restore_failed" });
  });

  it("restore refused: not an Owner, a pruned backup, another environment's backup — nothing on the server", async () => {
    const f = await liveOnBlue();
    expect(await runDbJob(backupJob(f, f.user.id, "manual"))).toBe("done");
    const target = (await backupsOf(f.live.id))[0]!;
    f.reset();
    await db.update(members).set({ role: "ADMIN" }).where(and(eq(members.workspaceId, f.ws.id), eq(members.userId, f.user.id)));
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("refused");
    await db.update(members).set({ role: "OWNER" }).where(and(eq(members.workspaceId, f.ws.id), eq(members.userId, f.user.id)));
    await db.update(appBackups).set({ deletedAt: new Date() }).where(eq(appBackups.id, target.id));
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("refused");
    const other = await liveOnBlue();
    const [foreign] = await db.insert(appBackups).values({ environmentId: other.live.id, workspaceId: other.ws.id, name: "manual-20261001T000000Z", kind: "manual" }).returning();
    expect(await runDbJob(restoreJob(f, f.user.id, foreign!.id))).toBe("refused");
    expect(srv.calls).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", statusMessage: "restore_failed" });
  });

  it("a restore cut off by a worker restart: the app started again, restore_failed, Owners told", async () => {
    const f = await liveOnBlue();
    await db.update(appEnvironments).set({ statusMessage: "restoring", maintenance: true }).where(eq(appEnvironments.id, f.live.id));
    srv.slotUnits.get(`${f.inst}:blue`)!.state = "inactive";
    expect(await recoverInterruptedRestores()).toContain(f.live.id);
    expect(srv.slotUnit(f.inst, "blue")?.state).toBe("active");
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", maintenance: false, statusMessage: "restore_failed" });
    expect(notifications(f.ws.id).map((n) => n.subject)).toEqual([expect.stringMatching(/^Database restore failed/)]);
  });

  it("a release on an environment a failed restore left behind the maintenance page: it says so and takes the page down", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    await db.update(appEnvironments).set({ maintenance: true, statusMessage: "restore_failed" }).where(eq(appEnvironments.id, f.live.id));
    srv.site.set(f.inst, { port: f.blue, maintenance: true });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    expect((await releaseRow(v2.id)).log).toMatch(/the maintenance page is on \(restore_failed\)/);
    expect(srv.site.get(f.inst)).toEqual({ port: f.green, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ maintenance: false, statusMessage: null });
    // nothing served before it (the page was up): no grace for blue
    expect(graceJobs()).toEqual([]);
  });

  it("the daily scheduler: one daily backup job per running live environment with a database, once a day", async () => {
    const f = await liveOnBlue();
    const out = await tickApps();
    expect(out.backups).toContain(f.live.id);
    expect(out.backups).not.toContain(f.preview.id);
    const jobs = transport.queued.filter((q) => q.name === "db_backup" && (q.data as { environmentId: string }).environmentId === f.live.id);
    expect(jobs.map((j) => j.data)).toEqual([{ kind: "db_backup", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, userId: null, backupKind: "daily" }]);
    // claimed: the next tick does not queue it again; a recent backup is not due either
    expect((await tickApps()).backups).not.toContain(f.live.id);
    await db.update(appEnvironments).set({ lastBackupAt: new Date() }).where(eq(appEnvironments.id, f.live.id));
    resetTransport();
    expect((await tickApps()).backups).not.toContain(f.live.id);
  });
});

describe("previews stay single-slot", () => {
  it("no --slot, no maintenance page, the old pre-migrate dump name; the dump is listed as a backup", async () => {
    const repo = makeRemote();
    const f = await makeApp({ remote: repo.remote });
    const r1 = await queueRelease(f.app, { createdBy: f.user.id });
    expect(await runRelease(r1.id, f.ws.id)).toBe("deployed");
    repo.commit({ "src/page.tsx": "v2" }, "v2");
    const r2 = await queueRelease(f.app, { createdBy: f.user.id });
    expect(await runRelease(r2.id, f.ws.id)).toBe("deployed");
    expect(srv.calls.some((c) => c.args.includes("--slot") || c.args.includes("--maintenance") || c.args.includes("--keep-kind"))).toBe(false);
    expect(srv.callsOf("db-dump").map((c) => c.args)).toEqual([[f.preview.instanceName, r2.id]]);
    expect(await backupsOf(f.preview.id)).toEqual([expect.objectContaining({ name: r2.id, kind: "pre_migrate", releaseId: r2.id })]);
    expect(srv.env).toContain(`PORT=${f.preview.port}\n`);
    expect(graceJobs()).toEqual([]);
  });
  const backupsOf = (envId: string) => db.select().from(appBackups).where(eq(appBackups.environmentId, envId));
});

describe("expand scan", () => {
  const scan = (sql: string) => expandViolationsIn([{ file: "m.sql", line: sql }]).map((v) => v.what);
  it.each([
    ["ALTER TABLE orders ADD COLUMN note text;", []],
    ['ALTER TABLE "orders" ADD COLUMN "type" text;', []],
    ["ALTER TABLE orders ADD COLUMN n int NOT NULL DEFAULT 0;", []],
    ['CREATE TABLE "x" ("id" uuid NOT NULL, CONSTRAINT fk FOREIGN KEY ("u") REFERENCES u(id) ON DELETE CASCADE);', []],
    ["CREATE INDEX idx ON orders (note); -- we may DROP it later", []],
    ["INSERT INTO notes VALUES ('nothing to see');", []],
    ["INSERT INTO notes VALUES ('DROP TABLE x');", ["DROP"]],
    ["DO $$ BEGIN EXECUTE 'ALTER TABLE a RENAME TO b'; END $$;", ["RENAME"]],
    ["ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users(id);", ["ADD CONSTRAINT"]],
    ["CREATE UNIQUE INDEX orders_ref ON orders (ref);", ["CREATE UNIQUE INDEX"]],
    ["UPDATE orders SET note = '';", ["UPDATE … SET"]],
    ["CREATE TABLE t (u int REFERENCES users(id) ON DELETE CASCADE ON UPDATE SET NULL);", []],
    ["CREATE OR REPLACE VIEW v AS SELECT 1;", ["CREATE OR REPLACE"]],
    ["create or replace function f() returns int as $$ select 1 $$ language sql;", ["CREATE OR REPLACE"]],
    ["ALTER TABLE orders ENABLE ROW LEVEL SECURITY;", ["ALTER … DISABLE / ENABLE"]],
    ["alter table orders disable trigger all;", ["ALTER … DISABLE / ENABLE"]],
    ["ALTER TABLE orders ADD COLUMN n int NOT NULL;", ["ADD … NOT NULL without DEFAULT"]],
    ["ALTER TABLE orders ADD COLUMN a int DEFAULT 1, ADD COLUMN b int NOT NULL;", ["ADD … NOT NULL without DEFAULT"]],
    ["ALTER TABLE orders DROP COLUMN note;", ["DROP"]],
    ["ALTER TABLE orders ALTER COLUMN note DROP DEFAULT;", ["DROP"]],
    ["ALTER TABLE orders RENAME TO purchases;", ["RENAME"]],
    ["ALTER TABLE orders ALTER COLUMN qty TYPE bigint;", ["ALTER … TYPE"]],
    ["ALTER TABLE orders ALTER COLUMN qty SET DATA TYPE bigint;", ["ALTER … TYPE"]],
    ["ALTER TABLE orders ALTER COLUMN qty SET NOT NULL;", ["SET NOT NULL"]],
    ["DELETE FROM carts;", ["DELETE"]],
    ["TRUNCATE sessions;", ["TRUNCATE"]],
  ])("%s", (sql, want) => {
    expect(scan(sql)).toEqual(want);
  });

  it("what cannot be judged refuses expand: non-SQL migrations, deleted SQL, a Prisma schema that removes; bookkeeping is ignored", () => {
    const ch = (file: string, status: "A" | "M" | "D", added: string[] = [], removed: string[] = [], binary = false) => ({ file, status, added, removed, binary });
    expect(
      expandViolationsOf([
        ch("drizzle/meta/0002_snapshot.json", "A", ['{"x": 1}']),
        ch("drizzle/meta/_journal.json", "M", ['"idx": 2'], ['"idx": 1']),
        ch("prisma/migrations/migration_lock.toml", "M"),
        ch("prisma/schema.prisma", "M", ["  note String?", "  // a comment"], ["", "// old comment"]),
        ch("drizzle/0002_add.sql", "A", ["ALTER TABLE orders ADD COLUMN note text;"]),
      ]),
    ).toEqual([]);
    expect(expandViolationsOf([ch("db/migrate/0003_backfill.js", "A", ["exports.up = (k) => k.schema.dropTable('x')"])]).map((v) => v.what)).toEqual([
      "a migration that is not plain SQL (its effect cannot be checked)",
    ]);
    expect(expandViolationsOf([ch("prisma/schema.prisma", "M", ["  qty BigInt"], ["  qty Int"])]).map((v) => v.statement)).toEqual(["qty Int"]);
    expect(expandViolationsOf([ch("migrations/0001.sql", "D")]).map((v) => v.what)).toEqual(["a deleted migration"]);
    expect(expandViolationsOf([ch("sql/seed.sql", "A", [], [], true)]).map((v) => v.what)).toEqual(["a migration that is not plain SQL (its effect cannot be checked)"]);
  });

  it("a release claiming expand with a JS migration (db/migrate) is refused, saying to mark it breaking; nothing on the server", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const rel = await f.promote({ "db/migrate/20261014_note.js": "exports.up = (knex) => knex.schema.table('orders', (t) => t.text('note'));\n" });
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/db\/migrate\/20261014_note\.js contains a migration that is not plain SQL.*"migrations": "breaking".*best-effort lint/);
    expect(srv.calls).toEqual([]);
  });

  it("a statement over several lines is judged whole", () => {
    expect(expandViolationsIn([{ file: "a.sql", line: "ALTER TABLE orders" }, { file: "a.sql", line: "  ADD COLUMN n int" }, { file: "a.sql", line: "  NOT NULL;" }])).toEqual([
      { file: "a.sql", what: "ADD … NOT NULL without DEFAULT", statement: "ALTER TABLE orders ADD COLUMN n int NOT NULL" },
    ]);
  });
});

describe("review fixes (B2)", () => {
  const restoreJob = (f: { app: { id: string }; ws: { id: string }; live: { id: string } }, userId: string, backupId: string) =>
    ({ kind: "db_restore", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, userId, backupId }) as Extract<DeployJob, { kind: "db_restore" }>;
  const manualBackup = async (f: { app: { id: string }; ws: { id: string }; live: { id: string }; user: { id: string } }) => {
    expect(await runDbJob({ kind: "db_backup", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, userId: f.user.id, backupKind: "manual" })).toBe("done");
    return (await db.select().from(appBackups).where(and(eq(appBackups.environmentId, f.live.id), eq(appBackups.kind, "manual"))))[0]!;
  };

  it("M3: a pre_restore dump that fails (taken with the app stopped): the app started again, page off, nothing restored", async () => {
    const f = await liveOnBlue();
    const target = await manualBackup(f);
    f.reset();
    srv.replies["db-dump"] = { code: 1, stderr: "pg_dump: error\n" };
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("failed");
    expect(steps()).toEqual([`publish:${f.blue}+m`, "unit-stop@blue", "db-dump", "unit-start@blue", `health:${f.blue}`, `publish:${f.blue}`]);
    expect(srv.callsOf("db-restore")).toEqual([]);
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", maintenance: false, statusMessage: "restore_failed" });
    expect(notifications(f.ws.id)[0]!.text).toMatch(/Nothing was changed/);
  });

  it("M6: a restore of an environment behind the maintenance page starts it (page off when it answers); a stopped one stays stopped", async () => {
    const f = await liveOnBlue();
    const target = await manualBackup(f);
    await db.update(appEnvironments).set({ status: "failed", maintenance: true, statusMessage: "restore_failed" }).where(eq(appEnvironments.id, f.live.id));
    srv.site.set(f.inst, { port: f.blue, maintenance: true });
    srv.slotUnits.get(`${f.inst}:blue`)!.state = "inactive";
    f.reset();
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("done");
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", maintenance: false, statusMessage: null });

    // stopped: no page, nothing started, flag stays off
    expect(await runAppAction({ kind: "app_action", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, action: "stop", userId: f.user.id })).toBe("done");
    f.reset();
    expect(await runDbJob(restoreJob(f, f.user.id, target.id))).toBe("done");
    expect(steps()).toEqual(["unit-stop@blue", "db-dump", "db-backups", "db-restore"]);
    expect(srv.site.get(f.inst)).toBeUndefined();
    expect(await envRow(f.live.id)).toMatchObject({ status: "stopped", maintenance: false });
  });

  it("M6: a release that fails before switching leaves the maintenance flag as nginx has it", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    await db.update(appEnvironments).set({ maintenance: true, statusMessage: "restore_failed" }).where(eq(appEnvironments.id, f.live.id));
    srv.site.set(f.inst, { port: f.blue, maintenance: true });
    const rel = await f.promote(addColumn());
    srv.healthy = (sha) => sha !== rel.commit;
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: true });
    expect(await envRow(f.live.id)).toMatchObject({ maintenance: true });
  });

  it("M7: a reused build still runs its migration (the helper refuses it in an active slot: a clear refusal, blue keeps serving)", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    expect(await runSlotStop(graceJobs()[0]!.data as SlotStopJob)).toBe("done");
    const rb = await queueRelease(f.app, { environmentId: f.live.id, trigger: "rollback", rollbackOfId: f.first.id, commit: f.first.commit, branch: "main", manifest: f.first.manifest, createdBy: f.user.id });
    expect(await runRelease(rb.id, f.ws.id)).toBe("deployed"); // v1 in blue, v2 still in green's link
    f.reset();
    const again = await queueRelease(f.app, { environmentId: f.live.id, commit: v2.commit, promotedFromReleaseId: v2.promotedFromReleaseId, createdBy: f.user.id });
    expect(await runRelease(again.id, f.ws.id)).toBe("failed");
    expect(srv.callsOf("build-run").map((c) => c.args[2])).toEqual(["migrate"]);
    expect((await releaseRow(again.id)).error).toMatch(/cannot run: its release folder is a slot's/);
    expect(srv.site.get(f.inst)).toEqual({ port: f.blue, maintenance: false });
    expect(await envRow(f.live.id)).toMatchObject({ status: "running", activeSlot: "blue", currentReleaseId: rb.id });
  });

  it("L10: a stop whose grace unit-stop fails keeps the grace pending", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    srv.replies["unit-stop"] = (c) => (FakeServer.slotOf(c) === "blue" ? { code: 1, stderr: "busy\n" } : undefined);
    expect(await runAppAction({ kind: "app_action", appId: f.app.id, workspaceId: f.ws.id, environmentId: f.live.id, action: "stop", userId: f.user.id })).toBe("done");
    expect(await cp(v2.id)).toMatchObject({ graceDone: false });
  });

  it("L12: restoring a pre_restore backup: the new pre_restore dump keeps enough of its kind to protect it", async () => {
    const f = await liveOnBlue();
    const names = Array.from({ length: 7 }, (_, i) => `pre-restore-2026091${i}T000000Z`);
    for (const [i, name] of names.entries()) {
      srv.backups.add(name);
      await db.insert(appBackups).values({ environmentId: f.live.id, workspaceId: f.ws.id, name, kind: "pre_restore", createdAt: new Date(Date.now() - (10 - i) * 86_400_000) });
    }
    const oldest = (await db.select().from(appBackups).where(and(eq(appBackups.environmentId, f.live.id), eq(appBackups.name, names[0]!))))[0]!;
    f.reset();
    expect(await runDbJob(restoreJob(f, f.user.id, oldest.id))).toBe("done");
    expect(srv.callsOf("db-dump")[0]!.args.slice(2)).toEqual(["--keep-kind", "pre-restore-", "8"]);
    expect(srv.callsOf("db-restore")[0]!.args).toEqual([f.inst, names[0]]);
    expect((await db.select().from(appBackups).where(eq(appBackups.id, oldest.id)))[0]!.deletedAt).toBeNull();
  });
});

describe("review fixes (B2), grace", () => {
  it("L9: the grace of the slot a release takes over is settled only after release-activate went through", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const v2 = await f.promote(addColumn());
    expect(await runRelease(v2.id, f.ws.id)).toBe("deployed");
    const v3 = await f.promote({ "src/page.tsx": "v3" });
    srv.replies["release-activate"] = { code: 1, stderr: "ln: failed\n" };
    expect(await runRelease(v3.id, f.ws.id)).toBe("failed");
    expect(await cp(v2.id)).toMatchObject({ graceDone: false, graceSlot: "blue" });
  });
});

describe("review fixes (B2), expand paths", () => {
  it("H1: a changed scripts/migrate.mjs cannot be judged: expand refused", async () => {
    const f = await liveOnBlue({ manifest: EXPAND });
    const rel = await f.promote({ "scripts/migrate.mjs": "await sql`ALTER TABLE orders ADD COLUMN note text`;\n" });
    expect(await runRelease(rel.id, f.ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/scripts\/migrate\.mjs contains a migration that is not plain SQL/);
    expect(srv.calls).toEqual([]);
  });
});
