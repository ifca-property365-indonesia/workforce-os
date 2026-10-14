import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { appEnvironments, appReleases, appUptimeChecks, approvals, apps, auditLog, db, members, repositories, servers, telegramCallbacks, users, workspaces } from "@wfos/db";
import { APP_PORT_MAX, APP_PORT_MIN, WFOS_HELPER_VERSION, isWithinReleaseWindow, type DomainCheck, type ReleaseWindow, type RequestReleasePayload } from "@wfos/shared";
import { newCallbackId, setTelegramFetch, signCallback } from "@wfos/shared/telegram";
import { totp } from "@wfos/shared/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as login2fa } from "@/app/api/auth/login/2fa/route";
import { POST as setup2fa } from "@/app/api/me/2fa/setup/route";
import { POST as enable2fa } from "@/app/api/me/2fa/enable/route";
import { POST as reauth } from "@/app/api/me/reauth/route";
import { GET as getApp } from "@/app/api/apps/[id]/route";
import { GET as getUptime } from "@/app/api/apps/[id]/uptime/route";
import { PATCH as patchLive } from "@/app/api/apps/[id]/live/route";
import { POST as deployApp } from "@/app/api/apps/[id]/deploy/route";
import { POST as rollbackApp } from "@/app/api/apps/[id]/rollback/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import { nextReleaseWindowOpening, sameReleaseWindow } from "@/lib/release-window";
import { incidentsOf } from "@/lib/server/uptime";
import type { UptimeReport } from "@/lib/uptime";
import { call, callWithParams, jar, queueModule, resetBrowser } from "./browser";

// public DNS is never asked in tests
vi.mock("@wfos/shared/dns", () => ({ checkDomains: vi.fn(async (names: string[]) => ({ status: "ok", expected: ["45.77.10.20"], names: names.map((name) => ({ name, status: "ok", found: ["45.77.10.20"] })), checkedAt: new Date().toISOString() })) }));

const PASSWORD = "pw-123456-liveops";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const deploy = vi.mocked(queueModule.q.deploy);
const action = vi.mocked(queueModule.q.action);
const dnsOk = (names: string[]): DomainCheck => ({ status: "ok", expected: ["45.77.10.20"], names: names.map((name) => ({ name, status: "ok", found: ["45.77.10.20"] })), checkedAt: new Date().toISOString() });

beforeEach(() => {
  resetBrowser();
  deploy.mockReset();
  action.mockReset();
  vi.mocked(queueModule.pendingDbJobs).mockResolvedValue([]);
});

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  return ws!;
}

async function signIn(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", wsId: string) {
  const email = `l-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: `${role} person`, passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: wsId, userId: u!.id, role });
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  return { email, userId: u!.id };
}

/** signed in with 2FA; `stepUp()` confirms password + code (valid 10 minutes) */
async function withTwoFactor(role: "OWNER" | "ADMIN", wsId: string) {
  const o = await signIn(role, wsId);
  const s = await call(setup2fa, "POST", "/api/me/2fa/setup");
  const secret = String(s.json.secret);
  expect((await call(enable2fa, "POST", "/api/me/2fa/enable", { code: totp(secret, Date.now() - 30_000) })).status).toBe(200);
  jar.clear();
  await call(login, "POST", "/api/auth/login", { email: o.email, password: PASSWORD });
  await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
  const stepUp = async () => expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
  return { ...o, stepUp };
}

/** an app with its preview and a running live environment (DNS ok) on a ready server */
async function liveApp(wsId: string, over: Partial<typeof appEnvironments.$inferInsert> = {}) {
  const base = `p${randomUUID().slice(0, 6)}.example.com`;
  const [server] = await db
    .insert(servers)
    .values({
      workspaceId: wsId,
      name: `srv-${base}`,
      host: "45.77.10.20",
      port: 22,
      baseDomain: base,
      status: "ready",
      info: { helperVersion: WFOS_HELPER_VERSION, os: "Ubuntu", node: "v24", pnpm: "10", nginx: true, certbot: true, postgresPort: 5433, diskFreeMb: 1, memTotalMb: 1, memAvailableMb: 1, baseDomain: base, systemd: 259, firewall: true, appsRoot: "/srv" },
    })
    .returning();
  const [repo] = await db.insert(repositories).values({ workspaceId: wsId, name: `repo-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/acme/shop.git", defaultBranch: "main" }).returning();
  const slug = `shop${randomUUID().slice(0, 4)}`;
  const [a] = await db.insert(apps).values({ workspaceId: wsId, repositoryId: repo!.id, name: `App ${slug}`, slug }).returning();
  const [preview] = await db
    .insert(appEnvironments)
    .values({ appId: a!.id, workspaceId: wsId, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.${base}`, port: APP_PORT_MIN + 300 + Math.floor(Math.random() * 100) })
    .returning();
  const domain = `${slug}.client.example`;
  const [live] = await db
    .insert(appEnvironments)
    .values({ appId: a!.id, workspaceId: wsId, kind: "live", serverId: server!.id, instanceName: `${slug}-live`, domain, port: APP_PORT_MAX - Math.floor(Math.random() * 150), accessMode: "public", status: "running", dnsCheck: dnsOk([domain]), ...over })
    .returning();
  return { app: a!, preview: preview!, live: live!, server: server! };
}

const p = (id: string) => ({ id });
const auditOf = (id: string, act: string) => db.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, act)));

/** a window around now (open) or two hours ahead (closed), on the UTC clock, every day */
function windowAround(open: boolean): ReleaseWindow {
  const now = new Date();
  const at = (h: number) => {
    const d = new Date(now.getTime() + h * 3_600_000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  return open ? { days: [0, 1, 2, 3, 4, 5, 6], start: at(-1), end: at(1), timeZone: "UTC" } : { days: [0, 1, 2, 3, 4, 5, 6], start: at(2), end: at(3), timeZone: "UTC" };
}

describe("release windows (web helpers)", () => {
  it("the next opening: the start of the next allowed day on the window's clock, null inside the window", () => {
    // 2026-10-14 is a Wednesday (3); Asia/Jakarta is UTC+7
    const w: ReleaseWindow = { days: [1, 5], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };
    const wed = new Date("2026-10-14T05:00:00Z"); // Wed 12:00 WIB
    expect(nextReleaseWindowOpening(w, wed)?.toISOString()).toBe("2026-10-16T15:00:00.000Z"); // Fri 22:00 WIB
    expect(nextReleaseWindowOpening(w, new Date("2026-10-16T16:00:00Z"))).toBeNull(); // Fri 23:00 WIB: inside
    // Sat 04:59 WIB is still Friday's window; at 05:00 it closes and Monday 22:00 is next
    expect(nextReleaseWindowOpening(w, new Date("2026-10-16T21:59:00Z"))).toBeNull();
    expect(nextReleaseWindowOpening(w, new Date("2026-10-16T22:00:00Z"))?.toISOString()).toBe("2026-10-19T15:00:00.000Z");
    // later the same day
    const day: ReleaseWindow = { days: [3], start: "09:00", end: "17:00", timeZone: "Asia/Jakarta" };
    expect(nextReleaseWindowOpening(day, new Date("2026-10-14T00:30:00Z"))?.toISOString()).toBe("2026-10-14T02:00:00.000Z");
    // a whole-day window opens at midnight; each opening lies inside its window
    const allDay: ReleaseWindow = { days: [6], start: "00:00", end: "00:00", timeZone: "Asia/Jakarta" };
    const o = nextReleaseWindowOpening(allDay, wed)!;
    expect(o.toISOString()).toBe("2026-10-16T17:00:00.000Z");
    expect(nextReleaseWindowOpening(day, wed)).toBeNull(); // Wed 12:00 WIB is inside 09:00–17:00
    for (const x of [w, allDay]) expect(isWithinReleaseWindow(x, nextReleaseWindowOpening(x, wed)!)).toBe(true);
  });

  it("compares windows field by field, whatever order the days or keys come in", () => {
    const a: ReleaseWindow = { days: [5, 1], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };
    expect(sameReleaseWindow(a, { timeZone: "Asia/Jakarta", end: "05:00", start: "22:00", days: [1, 5] })).toBe(true);
    expect(sameReleaseWindow(a, { ...a, end: "06:00" })).toBe(false);
    expect(sameReleaseWindow(a, null)).toBe(false);
    expect(sameReleaseWindow(null, null)).toBe(true);
  });
});

describe("live uptime", () => {
  it("the app DTO carries the live uptime, certificate and window; a preview reports unknown", async () => {
    const ws = await workspace();
    const since = new Date(Date.now() - 3_600_000);
    const cert = new Date(Date.now() + 40 * 86_400_000);
    const w: ReleaseWindow = { days: [1, 2], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };
    const { app } = await liveApp(ws.id, { uptimeStatus: "down", uptimeSince: since, uptimeCheckedAt: since, certExpiresAt: cert, releaseWindow: w });
    await signIn("VIEWER", ws.id);
    const r = await callWithParams(getApp, "GET", "/x", undefined, p(app.id));
    expect(r.status).toBe(200);
    const dto = r.json.app as { preview: Record<string, unknown>; live: Record<string, unknown> };
    expect(dto.live).toMatchObject({ uptimeStatus: "down", uptimeSince: since.toISOString(), uptimeCheckedAt: since.toISOString(), certExpiresAt: cert.toISOString(), releaseWindow: w });
    expect(dto.preview).toMatchObject({ uptimeStatus: "unknown", uptimeSince: null, uptimeCheckedAt: null, certExpiresAt: null, releaseWindow: null });
  });

  it("GET uptime: anyone in the workspace; 5-minute points for a day, hourly beyond, uptime % per range and incidents", async () => {
    const ws = await workspace();
    const { app, live } = await liveApp(ws.id, { uptimeStatus: "up", uptimeSince: new Date(Date.now() - 20 * 60_000), uptimeCheckedAt: new Date() });
    const now = Date.now();
    const min = (m: number) => new Date(now - m * 60_000);
    const rows: (typeof appUptimeChecks.$inferInsert)[] = [];
    // an old incident 10 days ago (3 failed checks), a dropped request 2 days ago (1 failed: no incident)
    for (const m of [10 * 1440 + 15, 10 * 1440 + 10, 10 * 1440 + 5]) rows.push({ environmentId: live.id, workspaceId: ws.id, checkedAt: min(m), ok: false, error: "timeout" });
    rows.push({ environmentId: live.id, workspaceId: ws.id, checkedAt: min(10 * 1440), ok: true, statusCode: 200, ms: 90 });
    rows.push({ environmentId: live.id, workspaceId: ws.id, checkedAt: min(2 * 1440), ok: false, statusCode: 502, error: "http 502" });
    // the last hour: good checks every 5 minutes except two failures 30 and 25 minutes ago
    for (let m = 55; m >= 0; m -= 5) {
      const bad = m === 30 || m === 25;
      rows.push({ environmentId: live.id, workspaceId: ws.id, checkedAt: min(m + 0.5), ok: !bad, statusCode: bad ? null : 200, ms: bad ? 10_000 : 100 + m, error: bad ? "timeout" : null });
    }
    // older than 30 days: outside every range
    rows.push({ environmentId: live.id, workspaceId: ws.id, checkedAt: min(31 * 1440), ok: false, error: "dns" });
    await db.insert(appUptimeChecks).values(rows);
    // another workspace's checks never leak in
    const other = await workspace();
    const theirs = await liveApp(other.id);
    await db.insert(appUptimeChecks).values({ environmentId: theirs.live.id, workspaceId: other.id, checkedAt: min(3), ok: false, error: "timeout" });

    await signIn("VIEWER", ws.id);
    const day = await callWithParams(getUptime, "GET", "/x?env=live&days=1", undefined, p(app.id));
    expect(day.status).toBe(200);
    const d = day.json as unknown as UptimeReport;
    expect(d).toMatchObject({ status: "up", days: 1, bucketMinutes: 5 });
    expect(d.checks).toHaveLength(12);
    expect(d.checks.filter((b) => b.failed)).toHaveLength(2);
    expect(d.checks.find((b) => b.failed)).toMatchObject({ total: 1, failed: 1, okPct: 0, avgMs: null, error: "timeout" });
    expect(d.checks.find((b) => !b.failed)).toMatchObject({ failed: 0, okPct: 100, error: null });
    for (const b of d.checks) expect(new Date(b.at).getTime() % 300_000).toBe(0);
    expect(d.pct.day).toBe(83.33); // 10 of 12
    expect(d.pct.week).toBe(76.92); // + the dropped request: 10 of 13
    expect(d.pct.month).toBe(64.71); // + the old incident: 11 of 17
    expect(d.uptimePct).toBe(d.pct.day);
    // within a day only the recent run counts (two failed checks in a row), closed by the good check after it
    expect(d.incidents).toEqual([{ from: min(30.5).toISOString(), to: min(20.5).toISOString(), minutes: 10 }]);

    const month = (await callWithParams(getUptime, "GET", "/x?env=live&days=30", undefined, p(app.id))).json as unknown as UptimeReport;
    expect(month.bucketMinutes).toBe(60);
    for (const b of month.checks) expect(new Date(b.at).getTime() % 3_600_000).toBe(0);
    expect(month.checks.reduce((n, b) => n + b.total, 0)).toBe(17);
    expect(month.incidents.map((i) => i.minutes)).toEqual([15, 10]);
    const week = (await callWithParams(getUptime, "GET", "/x?env=live&days=7", undefined, p(app.id))).json as unknown as UptimeReport;
    expect(week.incidents).toHaveLength(1);
    expect(week.uptimePct).toBe(76.92);

    // the preview is never checked; bad ranges; other workspaces' apps are not found
    const prev = (await callWithParams(getUptime, "GET", "/x?days=1", undefined, p(app.id))).json as unknown as UptimeReport;
    expect(prev).toMatchObject({ status: "unknown", checks: [], incidents: [], uptimePct: null });
    for (const days of ["2", "0", "1.0", "abc"]) {
      const bad = await callWithParams(getUptime, "GET", `/x?env=live&days=${days}`, undefined, p(app.id));
      expect(bad.status, days).toBe(400);
      expect(bad.json.code).toBe("uptime_days");
    }
    expect((await callWithParams(getUptime, "GET", "/x?env=live&days=1", undefined, p(theirs.app.id))).json.code).toBe("app_not_found");
  });

  it("an app without a live site has no live uptime", async () => {
    const ws = await workspace();
    const { app, live } = await liveApp(ws.id);
    await db.delete(appEnvironments).where(eq(appEnvironments.id, live.id));
    await signIn("VIEWER", ws.id);
    const r = await callWithParams(getUptime, "GET", "/x?env=live", undefined, p(app.id));
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("live_not_found");
  });

  it("incidents: two or more failed checks in a row; a run still failing is ongoing", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 14, 10, m));
    const rows = [
      { checkedAt: t(0), ok: false },
      { checkedAt: t(5), ok: true },
      { checkedAt: t(10), ok: false },
      { checkedAt: t(15), ok: false },
      { checkedAt: t(20), ok: true },
      { checkedAt: t(25), ok: false },
      { checkedAt: t(30), ok: false },
    ];
    expect(incidentsOf(rows, t(37))).toEqual([
      { from: t(10).toISOString(), to: t(20).toISOString(), minutes: 10 },
      { from: t(25).toISOString(), to: null, minutes: 12 },
    ]);
    expect(incidentsOf([], t(0))).toEqual([]);
    // a gap of more than 2 checks + 60 s ends the run at its last failed check: no incident across days without checks
    const day = (d: number, m: number) => new Date(Date.UTC(2026, 9, 14 + d, 10, m));
    expect(
      incidentsOf(
        [
          { checkedAt: day(0, 0), ok: false },
          { checkedAt: day(0, 5), ok: false },
          { checkedAt: day(3, 0), ok: false },
          { checkedAt: day(3, 5), ok: true },
        ],
        day(4, 0),
      ),
    ).toEqual([{ from: day(0, 0).toISOString(), to: day(0, 5).toISOString(), minutes: 5 }]);
    // a single failed check on each side of a gap is no incident; a failed run whose checks stopped is not ongoing
    expect(incidentsOf([{ checkedAt: day(0, 0), ok: false }, { checkedAt: day(1, 0), ok: false }], day(1, 1))).toEqual([]);
    expect(incidentsOf([{ checkedAt: t(0), ok: false }, { checkedAt: t(5), ok: false }], t(60))).toEqual([{ from: t(0).toISOString(), to: t(5).toISOString(), minutes: 5 }]);
    // within the gap the run goes on (10 min 30 s apart is still consecutive)
    expect(incidentsOf([{ checkedAt: t(0), ok: false }, { checkedAt: new Date(t(10).getTime() + 30_000), ok: false }], t(12))[0]).toMatchObject({ to: null });
  });
});

describe("release window setting and the LIVE release", () => {
  it("PATCH live releaseWindow: the Owner with a fresh step-up, a known time zone, audited; null removes it", async () => {
    const ws = await workspace();
    const { app, live } = await liveApp(ws.id);
    const w = { days: [5, 1, 1], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };
    const patch = (body: unknown) => callWithParams(patchLive, "PATCH", "/x", body, p(app.id));
    await signIn("ADMIN", ws.id);
    expect((await patch({ releaseWindow: w })).json).toMatchObject({ code: "role_required", role: "OWNER" });
    const o = await withTwoFactor("OWNER", ws.id);
    const noStepUp = await patch({ releaseWindow: w });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.json.code).toBe("step_up_required");
    await o.stepUp();
    const badZone = await patch({ releaseWindow: { ...w, timeZone: "Mars/Olympus" } });
    expect(badZone.status).toBe(400);
    expect(badZone.json.code).toBe("release_window_time_zone");
    expect((await patch({ releaseWindow: { ...w, start: "24:00" } })).status).toBe(400);
    expect((await patch({ releaseWindow: { ...w, days: [] } })).status).toBe(400);

    const r = await patch({ releaseWindow: w });
    expect(r.status).toBe(200);
    const stored = { days: [1, 5], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };
    expect((r.json.app as { live: { releaseWindow: unknown } }).live.releaseWindow).toEqual(stored);
    const [row] = await db.select().from(appEnvironments).where(eq(appEnvironments.id, live.id));
    expect(row!.releaseWindow).toEqual(stored);
    const [audited] = await auditOf(app.id, "app.live_updated");
    expect(audited!.details).toMatchObject({ environmentId: live.id, releaseWindow: { from: null, to: stored } });
    // a running site is not republished for a window
    expect(deploy).not.toHaveBeenCalled();
    // the same window again changes nothing
    await patch({ releaseWindow: { ...stored, days: [5, 1] } });
    expect(await auditOf(app.id, "app.live_updated")).toHaveLength(1);
    // null removes it
    const off = await patch({ releaseWindow: null });
    expect((off.json.app as { live: { releaseWindow: unknown } }).live.releaseWindow).toBeNull();
    expect(await auditOf(app.id, "app.live_updated")).toHaveLength(2);
  });

  it("access changes still need no step-up when the window is not touched", async () => {
    const ws = await workspace();
    const { app } = await liveApp(ws.id, { releaseWindow: { days: [1], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" } });
    await withTwoFactor("OWNER", ws.id);
    const r = await callWithParams(patchLive, "PATCH", "/x", { accessMode: "password", releaseWindow: { timeZone: "Asia/Jakarta", end: "05:00", start: "22:00", days: [1] } }, p(app.id));
    expect(r.status).toBe(200);
    expect((r.json.app as { live: { accessMode: string } }).live.accessMode).toBe("password");
  });

  it("deploy refuses a LIVE release outside the window (409 with the next opening); inside it goes; rollbacks always do", async () => {
    const ws = await workspace();
    const { app, preview, live } = await liveApp(ws.id, { releaseWindow: windowAround(false) });
    const ran = await db.insert(appReleases).values({ appId: app.id, workspaceId: ws.id, environmentId: preview.id, commit: SHA, branch: "main", status: "deployed", trigger: "manual" }).returning();
    const old = await db.insert(appReleases).values({ appId: app.id, workspaceId: ws.id, environmentId: live.id, commit: SHA2, branch: "main", status: "superseded", trigger: "manual" }).returning();
    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    const refused = await callWithParams(deployApp, "POST", "/x?env=live", { fromReleaseId: ran[0]!.id }, p(app.id));
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "live_outside_window", timeZone: "UTC" });
    const opensAt = new Date(String(refused.json.opensAt));
    expect(opensAt.getTime()).toBeGreaterThan(Date.now());
    expect(opensAt.getTime() - Date.now()).toBeLessThan(2 * 3_600_000 + 60_000);
    expect(String(refused.json.error)).toContain("UTC");
    expect(deploy).not.toHaveBeenCalled();

    // a rollback is never held back by the window
    const rb = await callWithParams(rollbackApp, "POST", "/x?env=live", { releaseId: old[0]!.id }, p(app.id));
    expect(rb.status).toBe(200);
    expect(rb.json.release).toMatchObject({ trigger: "rollback", environmentKind: "live" });
    await db.update(appReleases).set({ status: "deployed" }).where(eq(appReleases.environmentId, live.id));

    await db.update(appEnvironments).set({ releaseWindow: windowAround(true) }).where(eq(appEnvironments.id, live.id));
    const ok = await callWithParams(deployApp, "POST", "/x?env=live", { fromReleaseId: ran[0]!.id }, p(app.id));
    expect(ok.status).toBe(200);
    expect(ok.json.release).toMatchObject({ environmentKind: "live", promotedFromReleaseId: ran[0]!.id });
  });
});

/** a pending request_release of a live app (as the worker builds it) */
async function releaseApproval(wsId: string, over: Partial<typeof approvals.$inferInsert> = {}) {
  const { app, preview, live } = await liveApp(wsId);
  const [ran] = await db.insert(appReleases).values({ appId: app.id, workspaceId: wsId, environmentId: preview.id, commit: SHA, branch: "agent/x", status: "deployed", trigger: "approval" }).returning();
  // LIVE runs SHA2 now: the request was made against it
  const [cur] = await db.insert(appReleases).values({ appId: app.id, workspaceId: wsId, environmentId: live.id, commit: SHA2, branch: "main", status: "deployed", trigger: "manual" }).returning();
  await db.update(appEnvironments).set({ currentReleaseId: cur!.id }).where(eq(appEnvironments.id, live.id));
  const payload: RequestReleasePayload = {
    appId: app.id,
    appName: app.name,
    environmentId: live.id,
    url: `https://${live.domain}`,
    fromReleaseId: ran!.id,
    commit: SHA,
    commitSubject: "Guestbook v2",
    currentCommit: SHA2,
    commits: [{ sha: SHA, subject: "Guestbook v2" }],
    files: [{ path: "app/page.tsx", added: 3, removed: 1 }],
    filesTruncated: false,
    warnings: [],
    migrations: "expand",
    database: true,
    liveEnvChanged: ["SMTP_HOST"],
    releaseWindow: null,
    summary: "Ship v2",
  };
  const [a] = await db.insert(approvals).values({ workspaceId: wsId, toolName: "request_release", title: `Release ${app.name} to LIVE`, payload, ...over }).returning();
  return Object.assign(a!, { live });
}

const statusOf = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;

describe("request_release approvals: the Owner with a fresh step-up, never edited", () => {
  it("Admins can neither approve nor reject; the Owner needs a step-up; Edit & approve is refused", async () => {
    const ws = await workspace();
    const a = await releaseApproval(ws.id);
    const dec = (body: unknown) => callWithParams(decide, "POST", `/api/approvals/${a.id}/decide`, body, p(a.id));
    await withTwoFactor("ADMIN", ws.id);
    for (const body of [{ decision: "approve" }, { decision: "reject", feedback: "no" }]) {
      const r = await dec(body);
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ code: "role_required", role: "OWNER" });
    }
    const o = await withTwoFactor("OWNER", ws.id);
    for (const body of [{ decision: "approve" }, { decision: "reject" }]) {
      const r = await dec(body);
      expect(r.status).toBe(401);
      expect(r.json.code).toBe("step_up_required");
    }
    expect((await statusOf(a.id)).status).toBe("PENDING");
    await o.stepUp();
    const edit = await dec({ decision: "edit_approve", editedPayload: { ...a.payload, commit: SHA2 } });
    expect(edit.status).toBe(400);
    expect(edit.json.code).toBe("release_not_editable");
    expect(action).not.toHaveBeenCalled();

    const ok = await dec({ decision: "approve" });
    expect(ok.status).toBe(200);
    expect(await statusOf(a.id)).toMatchObject({ status: "APPROVED", decidedBy: o.userId, editedPayload: null });
    expect(action).toHaveBeenCalledWith({ kind: "execute_approval", approvalId: a.id, workspaceId: ws.id });
  });

  it("the Owner rejects with a step-up; other approvals keep the Admin rule without a step-up", async () => {
    const ws = await workspace();
    const a = await releaseApproval(ws.id);
    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    const r = await callWithParams(decide, "POST", `/api/approvals/${a.id}/decide`, { decision: "reject", feedback: "after the launch" }, p(a.id));
    expect(r.status).toBe(200);
    expect(await statusOf(a.id)).toMatchObject({ status: "REJECTED", feedback: "after the launch", decidedBy: o.userId });

    const [mail] = await db.insert(approvals).values({ workspaceId: ws.id, toolName: "send_email", title: "Mail", payload: { to: ["x@example.com"], subject: "s", body: "b" } }).returning();
    await signIn("ADMIN", ws.id);
    expect((await callWithParams(decide, "POST", "/x", { decision: "approve" }, p(mail!.id))).status).toBe(200);
  });
});

describe("request_release approvals: approve only while it still fits LIVE", () => {
  const approve = (id: string, decision = "approve") => callWithParams(decide, "POST", "/x", { decision }, p(id));

  it("outside the LIVE release window: approve 409 with the next opening; reject still works", async () => {
    const ws = await workspace();
    const a = await releaseApproval(ws.id);
    await db.update(appEnvironments).set({ releaseWindow: windowAround(false) }).where(eq(appEnvironments.id, a.live.id));
    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    const r = await approve(a.id);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "live_outside_window", timeZone: "UTC" });
    expect(new Date(String(r.json.opensAt)).getTime()).toBeGreaterThan(Date.now());
    expect((await statusOf(a.id)).status).toBe("PENDING");
    expect(action).not.toHaveBeenCalled();
    // inside the window it goes
    await db.update(appEnvironments).set({ releaseWindow: windowAround(true) }).where(eq(appEnvironments.id, a.live.id));
    expect((await approve(a.id)).status).toBe(200);

    const b = await releaseApproval(ws.id);
    await db.update(appEnvironments).set({ releaseWindow: windowAround(false) }).where(eq(appEnvironments.id, b.live.id));
    expect((await approve(b.id, "reject")).status).toBe(200);
    expect((await statusOf(b.id)).status).toBe("REJECTED");
  });

  it("older than 24 h: release_request_expired; LIVE moved on: release_request_stale; both can still be rejected", async () => {
    const ws = await workspace();
    const old = await releaseApproval(ws.id, { createdAt: new Date(Date.now() - 25 * 3_600_000) });
    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    const r1 = await approve(old.id);
    expect(r1.status).toBe(409);
    expect(r1.json.code).toBe("release_request_expired");

    const moved = await releaseApproval(ws.id);
    const [other] = await db.insert(appReleases).values({ appId: moved.payload.appId as string, workspaceId: ws.id, environmentId: moved.live.id, commit: "c".repeat(40), branch: "main", status: "deployed", trigger: "manual" }).returning();
    await db.update(appEnvironments).set({ currentReleaseId: other!.id }).where(eq(appEnvironments.id, moved.live.id));
    const r2 = await approve(moved.id);
    expect(r2.status).toBe(409);
    expect(r2.json.code).toBe("release_request_stale");
    // LIVE removed since: stale too
    const gone = await releaseApproval(ws.id);
    await db.delete(appEnvironments).where(eq(appEnvironments.id, gone.live.id));
    expect((await approve(gone.id)).json.code).toBe("release_request_stale");
    expect(action).not.toHaveBeenCalled();
    for (const x of [old, moved]) expect((await approve(x.id, "reject")).status).toBe(200);
  });
});

describe("request_release from Telegram", () => {
  const SECRET = "webhook-secret-for-tests-0123456789";
  let sent: { method: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    sent = [];
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    setTelegramFetch(async (url, init) => {
      sent.push({ method: url.split("/").pop()!, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    });
  });
  afterEach(() => {
    setTelegramFetch(null);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it("an Owner's approve or reject button is refused: decide it on the web", async () => {
    const ws = await workspace();
    const a = await releaseApproval(ws.id);
    const chatId = Math.floor(Math.random() * 1e9);
    const [u] = await db.insert(users).values({ email: `tg-${randomUUID().slice(0, 8)}@test.local`, name: "O", passwordHash: "x", telegramChatId: String(chatId) }).returning();
    await db.insert(members).values({ workspaceId: ws.id, userId: u!.id, role: "OWNER" });
    for (const act of ["approve", "reject"] as const) {
      const id = newCallbackId();
      await db.insert(telegramCallbacks).values({ id, userId: u!.id, workspaceId: ws.id, approvalId: a.id, action: act, expiresAt: new Date(Date.now() + 60_000) });
      const res = await webhook(
        new NextRequest("http://localhost:3010/api/telegram/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({ callback_query: { id: "cq", from: { id: chatId }, data: signCallback(id), message: { chat: { id: chatId }, message_id: 1 } } }),
        }),
      );
      expect(res.status).toBe(200);
      const answer = sent.filter((s) => s.method === "answerCallbackQuery").at(-1)?.body.text as string;
      expect(answer).toMatch(/on the web/);
      expect(answer).toMatch(/di web/);
    }
    expect((await statusOf(a.id)).status).toBe("PENDING");
    expect(action).not.toHaveBeenCalled();
    expect(sent.some((s) => s.method === "editMessageText")).toBe(false);
  });
});
