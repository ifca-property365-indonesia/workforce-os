import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { claudeLimits, db, setClaudeCredential, tasks, workspaces } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { fetchUsageWindows, recordUsageWindows, resetUsageSyncDue, usageSyncDue, RUN_USAGE_SYNC_MIN_MS } from "../src/lib/limits";
import { resetUsageSync, syncSubscriptionUsage, USAGE_UNAVAILABLE_BACKOFF_MS } from "../src/scheduler/usage";
import type { QueryFn } from "../src/runner/sdk";
import { resetTransport, transport } from "./transport";
import fixtures from "./fixtures/rate-limit-events.json";

type Fx = Exclude<keyof typeof fixtures, "_comment">;
/** A recorded event with resetsAt replaced by a time relative to now (epoch seconds, as the SDK sends it). */
// one base time for the file: real events carry a fixed reset time per window, so two runs must not straddle a second
const BASE = Math.floor(Date.now() / 1000);
function ev(name: Fx, resetsInSec = 3600) {
  const e = structuredClone(fixtures[name]) as { rate_limit_info: { resetsAt: number } };
  e.rate_limit_info.resetsAt = BASE + resetsInSec;
  return { event: e } as MockStep;
}

async function oauthWorkspace() {
  const ws = await makeWorkspace();
  await setClaudeCredential(ws.id, "oauth", "sk-ant-oat01-limits-test-0000000000");
  const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "send_email", enabled: true }] });
  return { ws, emp };
}

const notifies = () => transport.queued.filter((q) => q.name === "notify").map((q) => (q.data as { subject: string }).subject);

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

describe("Claude subscription limit meter", () => {
  it("stores the latest value per workspace credential and window", async () => {
    const { ws, emp } = await oauthWorkspace();
    setQueryImpl(mockRunner([ev("allowed_five_hour"), ev("allowed_weekly", 5 * 86400), ev("weekly_opus", 5 * 86400), { result: "ok" }]).query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    const rows = await db.select().from(claudeLimits).where(eq(claudeLimits.workspaceId, ws.id));
    expect(rows.map((r) => [r.rateLimitType, r.credentialSource, r.utilization]).sort()).toEqual([
      ["five_hour", "workspace", 0.42],
      ["seven_day", "workspace", 0.1],
      ["seven_day_opus", "workspace", 0.33],
    ]);
    expect(rows.find((r) => r.rateLimitType === "five_hour")!.resetsAt!.getTime()).toBeGreaterThan(Date.now());
    expect(transport.published.some((p) => (p.ev as { type: string }).type === "limits.updated")).toBe(true);
    expect(notifies()).toEqual(["Task finished: Test task"]);
  });

  it("warns once at 70% and once at 90% per window", async () => {
    const { ws, emp } = await oauthWorkspace();
    setQueryImpl(mockRunner([ev("warning_72"), ev("warning_75"), ev("warning_91"), { result: "ok" }]).query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    const warnings = notifies().filter((s) => s.includes("%"));
    expect(warnings).toEqual(["Claude subscription at 72% of the 5-hour limit", "Claude subscription at 91% of the 5-hour limit"]);
    // the same window again: no repeat
    resetTransport();
    setQueryImpl(mockRunner([ev("warning_91"), { result: "ok" }]).query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    expect(notifies().filter((s) => s.includes("%"))).toEqual([]);
    // a new window (different reset time) warns again
    setQueryImpl(mockRunner([ev("warning_72", 7200), { result: "ok" }]).query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    expect(notifies().filter((s) => s.includes("%"))).toEqual(["Claude subscription at 72% of the 5-hour limit"]);
  });

  it("writes warnings in the workspace language", async () => {
    const { ws, emp } = await oauthWorkspace();
    await db.update(workspaces).set({ defaultLocale: "id" }).where(eq(workspaces.id, ws.id));
    setQueryImpl(mockRunner([ev("warning_91"), { result: "ok" }]).query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    expect(notifies()).toContain("Langganan Claude sudah 91% dari batas 5 jam");
  });

  it("ignores subscription events for API-key credentials (they keep the credit meter)", async () => {
    const ws = await makeWorkspace();
    await setClaudeCredential(ws.id, "api_key", "sk-ant-api03-limits-test-00000000000");
    const emp = await makeEmployee(ws.id);
    setQueryImpl(mockRunner([ev("rejected"), { result: "ok" }]).query);
    const t = await makeTask(ws.id, emp.id);
    await runTask(t.id);
    expect(await db.select().from(claudeLimits).where(eq(claudeLimits.workspaceId, ws.id))).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0]!.status).toBe("DONE");
  });

  it("a rejection stops the run, pauses the queue and resumes after the reset", async () => {
    const { ws, emp } = await oauthWorkspace();
    const mock = mockRunner([ev("allowed_five_hour"), ev("rejected", 1800), { tool: "mcp__wfos__send_email", input: { to: ["a@b.co"], subject: "x", body: "y" } }, { result: "never" }]);
    setQueryImpl(mock.query);
    const t = await makeTask(ws.id, emp.id);
    await runTask(t.id);
    expect(mock.calls).toHaveLength(0); // nothing after the rejection ran
    const [task] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(task!.status).toBe("QUEUED");
    expect(task!.error).toMatch(/subscription limit; resumes automatically/);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w!.quotaPausedUntil!.getTime()).toBeGreaterThan(Date.now() + 1700_000);
    expect(w!.quotaPauseReason).toMatch(/limit was reached/);
    expect(notifies()).toContain("Claude subscription limit reached: work is paused");
    const requeue = transport.queued.find((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === t.id);
    expect(requeue).toBeTruthy();
    expect(transport.published.some((p) => (p.ev as { type: string }).type === "quota.paused")).toBe(true);
    const [row] = await db.select().from(claudeLimits).where(and(eq(claudeLimits.workspaceId, ws.id), eq(claudeLimits.rateLimitType, "five_hour")));
    expect(row!.status).toBe("rejected");

    // while paused, other tasks are held without starting the agent
    const other = await makeTask(ws.id, emp.id);
    const held = mockRunner([{ result: "should not run" }]);
    setQueryImpl(held.query);
    await runTask(other.id);
    expect(held.started).toBe(0);
    expect((await db.select().from(tasks).where(eq(tasks.id, other.id)))[0]!.error).toMatch(/^Paused:/);

    // after the reset, work resumes
    await db.update(workspaces).set({ quotaPausedUntil: new Date(Date.now() - 1000) }).where(eq(workspaces.id, ws.id));
    const after = mockRunner([{ result: "resumed" }]);
    setQueryImpl(after.query);
    await runTask(other.id);
    expect(after.started).toBe(1);
    expect((await db.select().from(tasks).where(eq(tasks.id, other.id)))[0]!.status).toBe("DONE");
    expect((await db.select().from(workspaces).where(eq(workspaces.id, ws.id)))[0]!.quotaPausedUntil).toBeNull();
  });
});

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const usageResponse = (fiveHour: number, weekly: number, weeklyReset = new Date(Date.now() + 3 * 86_400_000)) => ({
  rate_limits_available: true,
  subscription_type: "max",
  rate_limits: {
    five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() },
    seven_day: { utilization: weekly, resets_at: weeklyReset.toISOString() },
    model_scoped: [{ display_name: "Opus", utilization: 20, resets_at: weeklyReset.toISOString() }],
  },
});

describe("subscription usage from Claude (usage call + 15-minute sync)", () => {
  beforeEach(() => {
    resetUsageSync();
    resetUsageSyncDue();
  });

  it("fetchUsageWindows: method absent, throwing or too slow → null; otherwise the windows", async () => {
    expect(await fetchUsageWindows({})).toBeNull();
    expect(await fetchUsageWindows(null)).toBeNull();
    expect(await fetchUsageWindows({ [USAGE_METHOD]: () => Promise.reject(new Error("closed")) })).toBeNull();
    expect(await fetchUsageWindows({ [USAGE_METHOD]: () => { throw new Error("sync throw"); } })).toBeNull();
    expect(await fetchUsageWindows({ [USAGE_METHOD]: () => new Promise(() => {}) }, 20)).toBeNull();
    expect(await fetchUsageWindows({ [USAGE_METHOD]: async () => ({ rate_limits_available: false, rate_limits: null }) })).toEqual([]);
    const w = await fetchUsageWindows({ [USAGE_METHOD]: async (o: { skipBehaviors?: boolean }) => (o.skipBehaviors ? usageResponse(10, 40) : null) });
    expect(w!.map((x) => [x.type, x.utilization])).toEqual([["five_hour", 0.1], ["seven_day", 0.4], ["seven_day_model:Opus", 0.2]]);
  });

  it("replaces the frozen production row (weekly 83 %, reset in the past) and warns once per window", async () => {
    const { ws } = await oauthWorkspace();
    await db.insert(claudeLimits).values({ workspaceId: ws.id, credentialSource: "workspace", rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.83, resetsAt: new Date("2026-10-11T07:00:00Z"), warnedThreshold: 70 });
    const reset = new Date(Date.now() + 3 * 86_400_000);
    const w = (await fetchUsageWindows({ [USAGE_METHOD]: async () => usageResponse(15, 72, reset) }))!;
    expect(await recordUsageWindows(ws.id, "workspace", w)).toBe(3);
    const rows = await db.select().from(claudeLimits).where(eq(claudeLimits.workspaceId, ws.id));
    const weekly = rows.find((r) => r.rateLimitType === "seven_day")!;
    expect(weekly).toMatchObject({ status: "allowed_warning", utilization: 0.72, warnedThreshold: 70 });
    expect(weekly.resetsAt!.getTime()).toBe(reset.getTime());
    expect(rows.find((r) => r.rateLimitType === "five_hour")).toMatchObject({ status: "allowed", utilization: 0.15 });
    expect(rows.find((r) => r.rateLimitType === "seven_day_model:Opus")).toMatchObject({ utilization: 0.2 });
    // a new weekly window: the 70 % warning is sent (once)
    expect(notifies().filter((s) => s.includes("%"))).toHaveLength(1);
    resetTransport();
    await recordUsageWindows(ws.id, "workspace", w);
    expect(notifies().filter((s) => s.includes("%"))).toEqual([]);
    expect(transport.published.some((p) => (p.ev as { type: string }).type === "limits.updated")).toBe(true);
    // the sync never pauses the queue, even at 100 %
    await recordUsageWindows(ws.id, "workspace", (await fetchUsageWindows({ [USAGE_METHOD]: async () => usageResponse(100, 72, reset) }))!);
    expect((await db.select().from(workspaces).where(eq(workspaces.id, ws.id)))[0]!.quotaPausedUntil).toBeNull();
  });

  it("a Tool-mode run reads the usage on its own query right after init (throttled per credential)", async () => {
    const { ws, emp } = await oauthWorkspace();
    let asked = 0;
    const withUsage = (steps: MockStep[]) => {
      const mock = mockRunner(steps);
      return ((params: Parameters<QueryFn>[0]) => {
        const q = mock.query(params) as unknown as Record<string, unknown>;
        q[USAGE_METHOD] = async () => (asked++, usageResponse(33, 44));
        return q;
      }) as unknown as QueryFn;
    };
    const init = { event: { type: "system", subtype: "init", session_id: "s", tools: ["mcp__wfos__send_email"], mcp_servers: [{ name: "wfos", status: "connected" }] } } as MockStep;
    setQueryImpl(withUsage([init, { result: "ok" }]));
    await runTask((await makeTask(ws.id, emp.id)).id);
    for (let i = 0; i < 50 && !(await db.select().from(claudeLimits).where(eq(claudeLimits.workspaceId, ws.id))).length; i++) await new Promise((r) => setTimeout(r, 20));
    const rows = await db.select().from(claudeLimits).where(eq(claudeLimits.workspaceId, ws.id));
    expect(rows.map((r) => [r.rateLimitType, r.utilization]).sort()).toEqual([["five_hour", 0.33], ["seven_day", 0.44], ["seven_day_model:Opus", 0.2]]);
    // the next run within RUN_USAGE_SYNC_MIN_MS does not ask again
    setQueryImpl(withUsage([init, { result: "ok" }]));
    await runTask((await makeTask(ws.id, emp.id)).id);
    expect(asked).toBe(1);
    expect(usageSyncDue("k", 1e12)).toBe(true);
    expect(usageSyncDue("k", 1e12 + RUN_USAGE_SYNC_MIN_MS - 1)).toBe(false);
    expect(usageSyncDue("k", 1e12 + RUN_USAGE_SYNC_MIN_MS)).toBe(true);
  });

  it("the sync stores per credential, backs off when unavailable, and never throws", async () => {
    const { ws } = await oauthWorkspace();
    const apiKey = await makeWorkspace();
    await setClaudeCredential(apiKey.id, "api_key", "sk-ant-api03-usage-sync-0000000000000");
    const calls: string[] = [];
    // the API-key workspace is never asked
    const ok = await syncSubscriptionUsage({ fetch: async (id) => (calls.push(id), (await fetchUsageWindows({ [USAGE_METHOD]: async () => usageResponse(5, 6) }))!) });
    expect(calls).not.toContain(apiKey.id);
    // one fetch per credential: every workspace with this same token shares it (the first one is asked)
    expect(new Set(calls).size).toBe(calls.length);
    expect(ok.stored).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(claudeLimits).where(and(eq(claudeLimits.workspaceId, ws.id), eq(claudeLimits.rateLimitType, "seven_day"))))[0]).toMatchObject({ utilization: 0.06 });

    // a fetch that throws, fails or reports no plan limits never throws out of the sync
    const now = Date.now() + 3_600_000;
    resetTransport(); // drops the once-per-period Redis claims
    await expect(syncSubscriptionUsage({ now, fetch: async () => { throw new Error("boom"); } })).resolves.toMatchObject({ stored: 0 });
    resetTransport();
    let asked = 0;
    const r = await syncSubscriptionUsage({ now, fetch: async () => (asked++, []) });
    expect(r.unavailable).toBeGreaterThanOrEqual(1);
    const before = asked;
    resetTransport();
    await syncSubscriptionUsage({ now: now + 60_000, fetch: async () => (asked++, []) });
    expect(asked).toBe(before); // backed off
    resetTransport();
    await syncSubscriptionUsage({ now: now + USAGE_UNAVAILABLE_BACKOFF_MS + 1, fetch: async () => (asked++, null) });
    expect(asked).toBeGreaterThan(before);
  });
});
