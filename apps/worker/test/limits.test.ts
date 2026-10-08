import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { claudeLimits, db, setClaudeCredential, tasks, workspaces } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
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
