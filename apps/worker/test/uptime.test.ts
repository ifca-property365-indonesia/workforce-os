import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appEnvironments, appReleases, appUptimeChecks, auditLog, db, members, users, workspaces } from "@wfos/db";
import { CERT_WARN_DAYS, UPTIME_CHECK_EVERY_MS, UPTIME_RETENTION_DAYS, type NotifyJob, type RealtimeEvent } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { FLAP_QUIET_MS, checkUrl, pinFor, shortError, tickUptime, uptimeBlocked, uptimeDeps, uptimeLimits, uptimeNet, uptimeTiming } from "../src/scheduler/uptime";
import { makeApp, makeLive, makeRemote, MANIFEST } from "./deploy-fixtures";
import { resetTransport, transport } from "./transport";

// Nothing here reaches a site: uptimeDeps.status / certExpiry answer per URL / domain, sleeps are instant.

type Answer = number | Error;
/** url → the answers of its next tries, in order (the last one repeats); anything else answers 200 */
let script = new Map<string, Answer[]>();
let calls: { url: string; headers: Record<string, string> }[] = [];
let certs = new Map<string, Date | Error>();
let certCalls: string[] = [];
let sleeps: number[] = [];

beforeAll(async () => {
  // LIVE environments other test files left behind are not due here (the tick checks at most 100 at a time)
  await db.update(appEnvironments).set({ uptimeCheckedAt: new Date("2100-01-01T00:00:00Z") }).where(eq(appEnvironments.kind, "live"));
});

beforeEach(() => {
  resetTransport();
  uptimeDeps.clock = () => performance.now();
  script = new Map();
  calls = [];
  certs = new Map();
  certCalls = [];
  sleeps = [];
  uptimeTiming.tries = 3;
  uptimeTiming.retryMs = 2000;
  uptimeDeps.status = async (url, headers) => {
    calls.push({ url, headers });
    const q = script.get(url);
    const a = !q?.length ? 200 : q.length > 1 ? q.shift()! : q[0]!;
    if (a instanceof Error) throw a;
    return a;
  };
  uptimeDeps.certExpiry = async (domain) => {
    certCalls.push(domain);
    const c = certs.get(domain);
    if (c instanceof Error) throw c;
    return c ?? null;
  };
  uptimeDeps.sleep = async (ms) => void sleeps.push(ms);
});

const DAY = 24 * 60 * 60_000;
const envRow = async (id: string) => (await db.select().from(appEnvironments).where(eq(appEnvironments.id, id)))[0]!;
const checksOf = (id: string) => db.select().from(appUptimeChecks).where(eq(appUptimeChecks.environmentId, id)).orderBy(appUptimeChecks.checkedAt);
const notifications = (workspaceId: string) => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob).filter((n) => n.workspaceId === workspaceId);
const auditsOf = (appId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.targetId, appId), eq(auditLog.action, action)));
const appUpdates = (envId: string) => transport.published.map((p) => p.ev as RealtimeEvent).filter((e) => e.type === "app.updated" && e.environmentId === envId);

/** A running LIVE environment (with its current release's manifest) of an app whose workspace has two Owners. */
async function runningLive(over: Parameters<typeof makeLive>[2] = {}) {
  const repo = makeRemote();
  const f = await makeApp({ remote: repo.remote, role: "OWNER" });
  const [u2] = await db.insert(users).values({ email: `owner2-${randomUUID().slice(0, 8)}@test.local`, name: "Owner 2", passwordHash: "x" }).returning();
  await db.insert(members).values({ workspaceId: f.ws.id, userId: u2!.id, role: "OWNER" });
  const [admin] = await db.insert(users).values({ email: `adm-${randomUUID().slice(0, 8)}@test.local`, name: "Admin", passwordHash: "x" }).returning();
  await db.insert(members).values({ workspaceId: f.ws.id, userId: admin!.id, role: "ADMIN" });
  const live = await makeLive(f.app, f.server.id, { status: "running", ...over });
  const [rel] = await db
    .insert(appReleases)
    .values({ appId: f.app.id, environmentId: live.id, workspaceId: f.ws.id, commit: repo.first, branch: "main", trigger: "manual", status: "deployed", manifest: { ...MANIFEST, health: "/healthz" } as never, finishedAt: new Date() })
    .returning();
  await db.update(appEnvironments).set({ currentReleaseId: rel!.id }).where(eq(appEnvironments.id, live.id));
  const url = `https://${live.domain}/healthz`;
  return { ...f, live: { ...live, currentReleaseId: rel!.id }, url, owners: [f.user.id, u2!.id], adminId: admin!.id };
}

/** tick `n` intervals after t0 (each tick is one check of a due environment) */
const at = (t0: number, n: number) => new Date(t0 + n * UPTIME_CHECK_EVERY_MS);
const mine = (out: Awaited<ReturnType<typeof tickUptime>>, envId: string) => out.checked.filter((c) => c.environmentId === envId);

describe("a check", () => {
  it("is ok when any of 3 tries answers 2xx (2 s apart), with the good try's time", async () => {
    let t = 0;
    uptimeDeps.clock = () => (t += 50);
    script.set("https://a.example/x", [new Error("socket hang up"), 503, 200]);
    const r = await checkUrl("https://a.example/x", {});
    expect(r).toEqual({ ok: true, statusCode: 200, ms: 50, error: null, tries: 3 });
    expect(sleeps).toEqual([2000, 2000]);
    script.set("https://b.example/x", [new Error("The operation was aborted due to timeout")]);
    expect(await checkUrl("https://b.example/x", {})).toMatchObject({ ok: false, statusCode: null, error: "timeout", tries: 3 });
    script.set("https://c.example/x", [502]);
    expect(await checkUrl("https://c.example/x", {})).toMatchObject({ ok: false, statusCode: 502, error: "HTTP 502" });
    // a first good try is enough: no retry
    sleeps.length = 0;
    expect(await checkUrl("https://d.example/x", {})).toMatchObject({ ok: true, tries: 1 });
    expect(sleeps).toEqual([]);
  });

  it("short reasons only, never a response body", () => {
    expect(shortError(new Error("getaddrinfo ENOTFOUND x.example"))).toBe("dns");
    expect(shortError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe("connection refused");
    expect(shortError(new Error("unable to verify the first certificate"))).toBe("tls");
    expect(shortError(new Error(`weird ${"x".repeat(300)}\nmore`))).toHaveLength(80);
  });
});

describe("uptime state machine", () => {
  it("one failed check is a blip (no alarm); down after 2 consecutive failed checks, once; back up after 1 good check", async () => {
    const f = await runningLive();
    const t0 = Date.now();

    // first good check: unknown → up (published, no notification, no audit)
    expect(mine(await tickUptime(at(t0, 0)), f.live.id)).toEqual([{ environmentId: f.live.id, ok: true, status: "up", changed: true }]);
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "up", uptimeSince: at(t0, 0), uptimeCheckedAt: at(t0, 0) });
    expect(appUpdates(f.live.id)).toHaveLength(1);
    expect(notifications(f.ws.id)).toEqual([]);
    // not due again before UPTIME_CHECK_EVERY_MS
    expect(mine(await tickUptime(new Date(t0 + 60_000)), f.live.id)).toEqual([]);

    // the NAT hairpin drops a request: the retry answers, nothing happens
    script.set(f.url, [new Error("socket hang up"), 200]);
    expect(mine(await tickUptime(at(t0, 1)), f.live.id)).toEqual([{ environmentId: f.live.id, ok: true, status: "up", changed: false }]);

    // a whole check fails once (3 tries): stays up, no alarm
    script.set(f.url, [502]);
    expect(mine(await tickUptime(at(t0, 2)), f.live.id)).toEqual([{ environmentId: f.live.id, ok: false, status: "up", changed: false }]);
    // and recovers: still nothing
    script.set(f.url, [200]);
    await tickUptime(at(t0, 3));
    expect(notifications(f.ws.id)).toEqual([]);
    expect((await envRow(f.live.id)).uptimeStatus).toBe("up");

    // two failed checks in a row: down, since the first of them; every Owner hears it once
    script.set(f.url, [new Error("connect ECONNREFUSED 203.0.113.10:443")]);
    await tickUptime(at(t0, 4));
    expect((await envRow(f.live.id)).uptimeStatus).toBe("up");
    const down = mine(await tickUptime(at(t0, 5)), f.live.id);
    expect(down).toEqual([{ environmentId: f.live.id, ok: false, status: "down", changed: true }]);
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "down", uptimeSince: at(t0, 4) });
    const n1 = notifications(f.ws.id);
    expect(n1.map((n) => n.userId).sort()).toEqual([...f.owners].sort());
    expect(n1[0]).toMatchObject({ notificationKind: "incident", subject: `LIVE is down: ${f.app.name} (LIVE)`, link: `/apps/${f.app.id}` });
    expect(n1[0]!.text).toContain(`https://${f.live.domain}`);
    expect(n1[0]!.text).toContain("connection refused");
    expect((await auditsOf(f.app.id, "app.uptime_down")).map((a) => a.details)).toEqual([expect.objectContaining({ environmentId: f.live.id, error: "connection refused" })]);

    // still down: no second alarm
    await tickUptime(at(t0, 6));
    expect(notifications(f.ws.id)).toHaveLength(2);
    expect(await auditsOf(f.app.id, "app.uptime_down")).toHaveLength(1);

    // one good check: up again, with the downtime (first failed check → now = 3 intervals = 15 min)
    resetTransport();
    script.set(f.url, [200]);
    expect(mine(await tickUptime(at(t0, 7)), f.live.id)).toEqual([{ environmentId: f.live.id, ok: true, status: "up", changed: true }]);
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "up", uptimeSince: at(t0, 7) });
    const n2 = notifications(f.ws.id);
    expect(n2).toHaveLength(2);
    expect(n2[0]).toMatchObject({ notificationKind: "incident", subject: `LIVE is back: ${f.app.name} (LIVE)` });
    expect(n2[0]!.text).toContain("about 15 min");
    expect(n2[0]!.text).toContain("HTTP 200");
    expect((await auditsOf(f.app.id, "app.uptime_up")).map((a) => a.details)).toEqual([expect.objectContaining({ environmentId: f.live.id, downMinutes: 15 })]);
    expect(appUpdates(f.live.id)).toHaveLength(1);

    // one row per check: ok, status code, ms, short error
    const rows = await checksOf(f.live.id);
    expect(rows.map((r) => r.ok)).toEqual([true, true, false, true, false, false, false, true]);
    expect(rows[2]).toMatchObject({ statusCode: 502, error: "HTTP 502" });
    expect(rows[4]).toMatchObject({ statusCode: null, error: "connection refused" });
    expect(rows[7]).toMatchObject({ ok: true, statusCode: 200, error: null, ms: expect.any(Number) });
  });

  it("down needs two consecutive stored failed checks, the earlier one recent; a good one in between resets it", async () => {
    const f = await runningLive();
    const t0 = Date.now();
    script.set(f.url, [503]);
    await tickUptime(at(t0, 0));
    script.set(f.url, [200]);
    await tickUptime(at(t0, 1));
    script.set(f.url, [503]);
    await tickUptime(at(t0, 2));
    expect((await envRow(f.live.id)).uptimeStatus).toBe("up");
    // the next stored check comes after a long gap (the worker was down): a first failure again
    await tickUptime(at(t0, 10));
    expect((await envRow(f.live.id)).uptimeStatus).toBe("up");
    expect(notifications(f.ws.id)).toEqual([]);
    // the one right after it: down, since the first of the two
    await tickUptime(at(t0, 11));
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "down", uptimeSince: at(t0, 10) });
    expect(notifications(f.ws.id)).toHaveLength(2);
  });

  it(`a flap (down again less than ${FLAP_QUIET_MS / 60_000} min after a recovery) is audited and published, not notified; one that lasts is, once`, async () => {
    const f = await runningLive();
    const t0 = Date.now();
    await tickUptime(at(t0, 0));
    script.set(f.url, [503]);
    await tickUptime(at(t0, 1));
    await tickUptime(at(t0, 2)); // down: notified (2 Owners)
    script.set(f.url, [200]);
    await tickUptime(at(t0, 3)); // up: notified
    expect(notifications(f.ws.id)).toHaveLength(4);
    resetTransport();
    script.set(f.url, [503]);
    await tickUptime(at(t0, 4));
    await tickUptime(at(t0, 5)); // down again 10 min after the recovery: quiet
    expect((await envRow(f.live.id)).uptimeStatus).toBe("down");
    expect(appUpdates(f.live.id)).toHaveLength(1);
    expect(notifications(f.ws.id)).toEqual([]);
    expect((await auditsOf(f.app.id, "app.uptime_down")).map((a) => a.details.notified).sort()).toEqual([false, true]);
    script.set(f.url, [200]);
    await tickUptime(at(t0, 6)); // and its recovery is quiet too
    expect(notifications(f.ws.id)).toEqual([]);
    expect((await auditsOf(f.app.id, "app.uptime_up")).map((a) => a.details.notified).sort()).toEqual([false, true]);

    // another quiet down that LASTS: told once FLAP_QUIET_MS after it began, then the recovery is told as well
    script.set(f.url, [503]);
    await tickUptime(at(t0, 7));
    await tickUptime(at(t0, 8)); // quiet (2 intervals after the last recovery)
    expect(notifications(f.ws.id)).toEqual([]);
    for (let i = 9; i <= 15; i++) await tickUptime(at(t0, i)); // 35 min after the change
    const late = notifications(f.ws.id);
    expect(late).toHaveLength(2);
    expect(late[0]!.subject).toBe(`LIVE is down: ${f.app.name} (LIVE)`);
    await tickUptime(at(t0, 16));
    expect(notifications(f.ws.id)).toHaveLength(2);
    script.set(f.url, [200]);
    await tickUptime(at(t0, 17));
    expect(notifications(f.ws.id).map((n) => n.subject)).toContain(`LIVE is back: ${f.app.name} (LIVE)`);
  });

  it("checks with the access login when the site has one", async () => {
    const f = await runningLive({ accessMode: "password", accessPasswordEnc: encryptSecret("pw-123") });
    await tickUptime(at(Date.now(), 0));
    const mineCalls = calls.filter((c) => c.url === f.url);
    expect(mineCalls).toEqual([{ url: f.url, headers: { authorization: `Basic ${Buffer.from("preview:pw-123").toString("base64")}` } }]);
  });

  it("skips previews, the maintenance page, restores, demo workspaces; a stopped LIVE goes back to unknown", async () => {
    const f = await runningLive();
    const g = await runningLive({ maintenance: true });
    const h = await runningLive({ statusMessage: "restoring" });
    const d = await runningLive();
    await db.update(workspaces).set({ demoMode: true }).where(eq(workspaces.id, d.ws.id));
    const t0 = Date.now();
    const out = await tickUptime(at(t0, 0));
    const checked = out.checked.map((c) => c.environmentId);
    expect(checked).toContain(f.live.id);
    for (const skipped of [g.live.id, h.live.id, d.live.id, f.preview.id]) expect(checked).not.toContain(skipped);
    expect(calls.map((c) => c.url)).not.toContain(`https://${f.preview.domain}/healthz`);

    // stopped by a person: no uptime any more
    await db.update(appEnvironments).set({ status: "stopped" }).where(eq(appEnvironments.id, f.live.id));
    const out2 = await tickUptime(at(t0, 1));
    expect(out2.reset).toContain(f.live.id);
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "unknown", uptimeSince: null });
    expect(mine(out2, f.live.id)).toEqual([]);
    // deploying (blue-green keeps serving): the status is kept, no check
    const k = await runningLive();
    await tickUptime(at(t0, 2));
    await db.update(appEnvironments).set({ status: "deploying" }).where(eq(appEnvironments.id, k.live.id));
    const out3 = await tickUptime(at(t0, 3));
    expect(out3.reset).not.toContain(k.live.id);
    expect(mine(out3, k.live.id)).toEqual([]);
    expect((await envRow(k.live.id)).uptimeStatus).toBe("up");
  });

  it("a check during which the environment changed (maintenance page, a release) is thrown away", async () => {
    const f = await runningLive();
    const t0 = Date.now();
    await tickUptime(at(t0, 0));
    script.set(f.url, [503]);
    await tickUptime(at(t0, 1));
    // the second failure happens while a breaking migration put the maintenance page on
    uptimeDeps.status = async (url) => {
      if (url === f.url) await db.update(appEnvironments).set({ maintenance: true }).where(eq(appEnvironments.id, f.live.id));
      return 503;
    };
    const out = await tickUptime(at(t0, 2));
    expect(out.discarded).toContain(f.live.id);
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "up" });
    expect(await checksOf(f.live.id)).toHaveLength(2);
    expect(notifications(f.ws.id)).toEqual([]);
  });

  it("two workers ticking at once check an environment once", async () => {
    const f = await runningLive();
    const now = at(Date.now(), 0);
    const [a, b] = await Promise.all([tickUptime(now), tickUptime(now)]);
    expect(mine(a, f.live.id).length + mine(b, f.live.id).length).toBe(1);
    expect(await checksOf(f.live.id)).toHaveLength(1);
  });

  it(`prunes checks older than ${UPTIME_RETENTION_DAYS} days, in batches`, async () => {
    const f = await runningLive();
    const now = Date.now() + 5 * DAY;
    await db.insert(appUptimeChecks).values([
      ...Array.from({ length: 5 }, (_, i) => ({ environmentId: f.live.id, workspaceId: f.ws.id, checkedAt: new Date(now - (UPTIME_RETENTION_DAYS + 1) * DAY - i * 60_000), ok: true })),
      { environmentId: f.live.id, workspaceId: f.ws.id, checkedAt: new Date(now - (UPTIME_RETENTION_DAYS - 1) * DAY), ok: true },
    ]);
    uptimeLimits.pruneBatch = 2;
    const out = await tickUptime(new Date(now)).finally(() => (uptimeLimits.pruneBatch = 5000));
    expect(out.pruned).toBeGreaterThanOrEqual(5);
    const left = await checksOf(f.live.id);
    expect(left.map((r) => r.checkedAt.getTime())).toEqual([now - (UPTIME_RETENTION_DAYS - 1) * DAY, now]);
  });
});

describe("where a check connects", () => {
  const real = uptimeNet.lookup;
  const dns = (m: Record<string, string[]>) =>
    (uptimeNet.lookup = async (h) => {
      if (!m[h]) throw new Error(`getaddrinfo ENOTFOUND ${h}`);
      return m[h]!.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    });

  it("never loopback, never a private address; the login only to the app server's own address", async () => {
    try {
      for (const ip of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "10.0.0.5", "169.254.169.254"]) expect(uptimeBlocked(ip), ip).toBe(true);
      expect(uptimeBlocked("93.184.216.34")).toBe(false);
      dns({ "site.example": ["93.184.216.34"], "srv.example": ["93.184.216.34"], "moved.example": ["151.101.1.69"], "loop.example": ["93.184.216.34", "127.0.0.1"] });
      expect(await pinFor("site.example", "srv.example")).toEqual({ address: "93.184.216.34", family: 4, serverAddress: true });
      expect(await pinFor("site.example", "93.184.216.34")).toMatchObject({ serverAddress: true });
      // the domain points somewhere else now: no login is sent there
      expect(await pinFor("moved.example", "srv.example")).toEqual({ address: "151.101.1.69", family: 4, serverAddress: false });
      await expect(pinFor("loop.example", "srv.example")).rejects.toThrow(/blocked address/);
      expect(shortError(new Error("loop.example resolves to 127.0.0.1: blocked address"))).toBe("blocked address");
    } finally {
      uptimeNet.lookup = real;
    }
  });
});

describe("certificate", () => {
  it("stores the served certificate's expiry during a good check; warns the Owners once a day within the warning time", async () => {
    const f = await runningLive();
    // 01:00 UTC tomorrow: the checks of "today" stay on one UTC day
    const d = new Date();
    const t0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 1);
    const far = new Date(t0 + 60 * DAY);
    certs.set(f.live.domain, far);
    await tickUptime(at(t0, 0));
    expect(certCalls).toContain(f.live.domain);
    expect((await envRow(f.live.id)).certExpiresAt).toEqual(far);
    expect(notifications(f.ws.id)).toEqual([]);

    // renewal failed: CERT_WARN_DAYS - 4 days left
    const soon = new Date(t0 + (CERT_WARN_DAYS - 4) * DAY);
    certs.set(f.live.domain, soon);
    const out = await tickUptime(at(t0, 1));
    expect(out.certWarnings).toEqual([f.live.id]);
    expect((await envRow(f.live.id)).certExpiresAt).toEqual(soon);
    const n = notifications(f.ws.id);
    expect(n.map((x) => x.userId).sort()).toEqual([...f.owners].sort());
    expect(n[0]).toMatchObject({ notificationKind: "incident", subject: `Certificate expires soon: ${f.app.name} (LIVE)` });
    expect(n[0]!.text).toContain(`in ${CERT_WARN_DAYS - 4} days`);
    // later checks the same day: no second warning
    await tickUptime(at(t0, 2));
    await tickUptime(at(t0, 3));
    expect(notifications(f.ws.id)).toHaveLength(2);
    // the next day: once more
    const out2 = await tickUptime(new Date(t0 + DAY + UPTIME_CHECK_EVERY_MS * 4));
    expect(out2.certWarnings).toEqual([f.live.id]);
    expect(notifications(f.ws.id)).toHaveLength(4);
  });

  it("is not read during a failed check, and a failed read changes nothing", async () => {
    const f = await runningLive();
    const t0 = Date.now();
    script.set(f.url, [503]);
    await tickUptime(at(t0, 0));
    expect(certCalls).not.toContain(f.live.domain);
    script.set(f.url, [200]);
    certs.set(f.live.domain, new Error("connect ETIMEDOUT"));
    await tickUptime(at(t0, 1));
    expect(certCalls).toContain(f.live.domain);
    expect(await envRow(f.live.id)).toMatchObject({ uptimeStatus: "up", certExpiresAt: null });
  });
});
