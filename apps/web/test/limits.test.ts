import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, claudeLimits, db, employees, members, setClaudeCredential, steps, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as limits } from "@/app/api/limits/route";
import { POST as resume } from "@/app/api/limits/resume/route";
import { GET as getBudget, PUT as putBudget } from "@/app/api/settings/usage-budget/route";
import { queueModule } from "./browser";
import { call, resetBrowser } from "./browser";

async function signedIn(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", credential: "oauth" | "api_key") {
  const email = `l-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  await setClaudeCredential(ws!.id, credential, credential === "oauth" ? "sk-ant-oat01-web-limits-000000000" : "sk-ant-api03-web-limits-0000000000");
  await db.insert(claudeLimits).values([
    { workspaceId: ws!.id, credentialSource: "workspace", rateLimitType: "seven_day", status: "allowed", utilization: 0.3, resetsAt: new Date(Date.now() + 86_400_000) },
    { workspaceId: ws!.id, credentialSource: "workspace", rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.8, resetsAt: new Date(Date.now() + 3_600_000) },
  ]);
  await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
  return ws!;
}

beforeEach(() => resetBrowser());

describe("subscription limit API", () => {
  it("shows the windows (5-hour first) for a subscription credential", async () => {
    await signedIn("MEMBER", "oauth");
    const r = await call(limits, "GET", "/api/limits");
    expect(r.json.subscription).toBe(true);
    expect((r.json.windows as { type: string; utilization: number }[]).map((w) => [w.type, w.utilization])).toEqual([
      ["five_hour", 0.8],
      ["seven_day", 0.3],
    ]);
    expect(typeof r.json.usdThisMonth).toBe("number");
  });

  it("a window whose reset passed shows as reset (no old numbers), per-model windows follow, with the last sync time", async () => {
    const ws = await signedIn("MEMBER", "oauth");
    // the production row: weekly 83 %, reset date in the past, never updated since
    await db
      .update(claudeLimits)
      .set({ status: "allowed_warning", utilization: 0.83, resetsAt: new Date(Date.now() - 4 * 86_400_000), updatedAt: new Date(Date.now() - 6 * 86_400_000) })
      .where(and(eq(claudeLimits.workspaceId, ws.id), eq(claudeLimits.rateLimitType, "seven_day")));
    await db.insert(claudeLimits).values({ workspaceId: ws.id, credentialSource: "workspace", rateLimitType: "seven_day_model:Opus", status: "allowed", utilization: 0.2, resetsAt: new Date(Date.now() + 86_400_000) });
    const r = await call(limits, "GET", "/api/limits");
    const windows = r.json.windows as { type: string; status: string; utilization: number | null; resetsAt: string | null; expired: boolean }[];
    expect(windows.map((w) => w.type)).toEqual(["five_hour", "seven_day", "seven_day_model:Opus"]);
    expect(windows[1]).toMatchObject({ type: "seven_day", status: "allowed", utilization: null, expired: true });
    expect(windows[0]).toMatchObject({ utilization: 0.8, expired: false });
    expect(new Date(r.json.syncedAt as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("hides the subscription meter for API-key workspaces", async () => {
    await signedIn("MEMBER", "api_key");
    const r = await call(limits, "GET", "/api/limits");
    expect(r.json.subscription).toBe(false);
    expect(r.json.windows).toEqual([]);
  });

  it("reports the pause and lets an admin resume held tasks by hand", async () => {
    const ws = await signedIn("ADMIN", "oauth");
    const [emp] = await db.insert(employees).values({ workspaceId: ws.id, name: "E", role: "R", model: "m" }).returning();
    const until = new Date(Date.now() + 3_600_000);
    await db.update(workspaces).set({ quotaPausedUntil: until, quotaPauseReason: "The 5-hour limit was reached." }).where(eq(workspaces.id, ws.id));
    const [held] = await db.insert(tasks).values({ workspaceId: ws.id, assigneeId: emp!.id, title: "held", status: "QUEUED", error: "Paused: The 5-hour limit was reached." }).returning();
    const [other] = await db.insert(tasks).values({ workspaceId: ws.id, assigneeId: emp!.id, title: "other", status: "QUEUED", error: null }).returning();
    const before = await call(limits, "GET", "/api/limits");
    expect(before.json.paused).toEqual({ until: until.toISOString(), reason: "The 5-hour limit was reached." });
    queueModule.q.task.mockClear();
    const r = await call(resume, "POST", "/api/limits/resume");
    expect(r.json.resumed).toBe(1);
    expect(queueModule.q.task).toHaveBeenCalledWith(held!.id, ws.id);
    expect(queueModule.q.task).not.toHaveBeenCalledWith(other!.id, ws.id);
    expect((await call(limits, "GET", "/api/limits")).json.paused).toBeNull();
  });

  it("only admins can resume", async () => {
    await signedIn("MEMBER", "oauth");
    expect((await call(resume, "POST", "/api/limits/resume")).status).toBe(403);
  });
});

describe("estimated usage meter", () => {
  it("returns per window the estimate with its basis, spend, projection, reset and state", async () => {
    const ws = await signedIn("VIEWER", "oauth");
    const [emp] = await db.insert(employees).values({ workspaceId: ws.id, name: "E", role: "R", model: "m" }).returning();
    await db.insert(steps).values({ workspaceId: ws.id, employeeId: emp!.id, kind: "llm", name: "llm_call", model: "claude-opus-5-5", credits: 1500, createdAt: new Date(Date.now() - 3_600_000) });
    // the weekly value was reported 2 hours ago (no longer fresh); calibration: $1 per percent
    await db.update(claudeLimits).set({ updatedAt: new Date(Date.now() - 7_200_000) }).where(eq(claudeLimits.workspaceId, ws.id));
    const calibration = { workspace: { seven_day: [{ at: new Date(Date.now() - 86_400_000).toISOString(), windowEnd: new Date(Date.now() - 3 * 86_400_000).toISOString(), spendUsd: 40, utilization: 0.4 }] } };
    await db.update(workspaces).set({ settings: { usageCalibration: calibration, usageBudget: { fiveHourUsd: 20 } } }).where(eq(workspaces.id, ws.id));
    const r = await call(limits, "GET", "/api/limits");
    const meter = r.json.meter as { scope: string; schedule: { source: string }; windows: Record<string, unknown>[] };
    expect(meter.scope).toBe("workforce_os_only");
    expect(meter.windows.map((w) => w.type)).toEqual(["five_hour", "seven_day"]);
    const [five, weekly] = meter.windows as [Record<string, unknown>, Record<string, unknown>];
    // 5-hour: Claude's 80 % is no longer fresh; the budget estimate ($15 of $20 = 75 %) is floored at it
    expect(five).toMatchObject({ basis: "budget", utilization: 0.8, spendUsd: 15, windowSource: "claude", state: "watch", reported: { utilization: 0.8, fresh: false } });
    // weekly: calibrated 15 % (floored at Claude's 30 %), with a projection and the reset time
    expect(weekly).toMatchObject({ basis: "calibrated", utilization: 0.3, spendUsd: 15, windowSource: "claude" });
    expect(weekly.estimate).toMatchObject({ basis: "calibrated", usdPerPercent: 1, points: 1 });
    for (const k of ["start", "resetsAt", "projectedUsd", "projectedUtilization", "state"]) expect(weekly[k]).not.toBeUndefined();
  });

  it("has no meter for API-key workspaces", async () => {
    await signedIn("MEMBER", "api_key");
    expect((await call(limits, "GET", "/api/limits")).json.meter).toBeNull();
  });
});

describe("/api/settings/usage-budget", () => {
  it("anyone reads it; only Owner/Admin change it, with an audit entry; other settings keys are kept", async () => {
    const ws = await signedIn("MEMBER", "oauth");
    await db.update(workspaces).set({ settings: { company: { legalName: "PT Kita" }, usageCalibration: { workspace: {} } } }).where(eq(workspaces.id, ws.id));
    const read = await call(getBudget, "GET", "/api/settings/usage-budget");
    expect(read.json.budget).toEqual({ weeklyUsd: null, fiveHourUsd: null, resetDow: null, resetHour: null, timezone: null });
    expect(read.json.schedule).toMatchObject({ source: "claude" }); // derived from the stored weekly reset
    expect((await call(putBudget, "PUT", "/api/settings/usage-budget", { weeklyUsd: 150 })).status).toBe(403);

    await db.update(members).set({ role: "ADMIN" }).where(eq(members.workspaceId, ws.id));
    resetBrowser();
    const [m] = await db.select({ userId: members.userId }).from(members).where(eq(members.workspaceId, ws.id));
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, m!.userId));
    await call(login, "POST", "/api/auth/login", { email: u!.email, password: "pw-123456" });
    const r = await call(putBudget, "PUT", "/api/settings/usage-budget", { weeklyUsd: 150, resetDow: 0, resetHour: 14, timezone: "Asia/Makassar" });
    expect(r.status).toBe(200);
    expect(r.json.budget).toEqual({ weeklyUsd: 150, fiveHourUsd: null, resetDow: 0, resetHour: 14, timezone: "Asia/Makassar" });
    expect(r.json.schedule).toEqual({ resetDow: 0, resetHour: 14, timezone: "Asia/Makassar", source: "custom" });
    // a partial update keeps the rest; null goes back to automatic
    const r2 = await call(putBudget, "PUT", "/api/settings/usage-budget", { resetDow: null, resetHour: null });
    expect(r2.json.budget).toMatchObject({ weeklyUsd: 150, resetDow: null, resetHour: null });
    expect((r2.json.schedule as { source: string }).source).toBe("claude");
    expect((await call(putBudget, "PUT", "/api/settings/usage-budget", { weeklyUsd: -5 })).status).toBe(400);
    expect((await call(putBudget, "PUT", "/api/settings/usage-budget", { timezone: "Nope/Nowhere" })).status).toBe(400);
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row!.settings).toMatchObject({ company: { legalName: "PT Kita" }, usageCalibration: { workspace: {} }, usageBudget: { weeklyUsd: 150 } });
    const logged = (await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws.id))).filter((l) => l.action === "settings.usage_budget_changed");
    expect(logged).toHaveLength(2);
    expect(logged.map((l) => l.details)).toContainEqual(expect.objectContaining({ before: expect.objectContaining({ weeklyUsd: null }), after: expect.objectContaining({ weeklyUsd: 150 }) }));
  });
});
