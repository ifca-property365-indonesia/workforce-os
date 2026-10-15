import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { claudeLimits, db, setClaudeCredential, steps, usageMeter, workspaces } from "@wfos/db";
import { parseUsageCalibration } from "@wfos/shared/usage-meter";
import { recordRateLimit, recordUsageWindows } from "../src/lib/limits";
import { makeEmployee, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

const H = 3_600_000;
const D = 24 * H;

async function oauthWorkspace(settings: Record<string, unknown> = {}) {
  const ws = await makeWorkspace({ settings, timezone: "Asia/Jakarta" });
  await setClaudeCredential(ws.id, "oauth", "sk-ant-oat01-meter-test-00000000000");
  const emp = await makeEmployee(ws.id);
  return { ws, emp };
}

/** A model step (credits: 1 credit = $0.01) at a time ago; tool steps carry credits too but are not Claude usage. */
async function spend(workspaceId: string, employeeId: string, usd: number, agoMs: number, kind: "llm" | "tool" = "llm") {
  await db.insert(steps).values({
    workspaceId,
    employeeId,
    kind,
    name: kind === "llm" ? "llm_call" : "send_email",
    model: kind === "llm" ? "claude-opus-5-5" : null,
    credits: usd * 100,
    createdAt: new Date(Date.now() - agoMs),
  });
}

const settingsOf = async (id: string) => (await db.select({ s: workspaces.settings }).from(workspaces).where(eq(workspaces.id, id)))[0]!.s;
const notifies = () => transport.queued.filter((q) => q.name === "notify");

beforeEach(() => resetTransport());

describe("usage meter calibration", () => {
  it("a usage-API value records our spend in that window against the reported percent", async () => {
    const { ws, emp } = await oauthWorkspace({ company: { legalName: "PT Kita" } });
    const weekEnd = new Date(Date.now() + 3 * D); // the window started 4 days ago
    await spend(ws.id, emp.id, 30, 2 * D);
    await spend(ws.id, emp.id, 10, 1 * H);
    await spend(ws.id, emp.id, 99, 2 * H, "tool"); // not Claude usage
    await spend(ws.id, emp.id, 50, 5 * D); // before the window
    await recordUsageWindows(ws.id, "workspace", [
      { type: "seven_day", status: null, utilization: 0.4, resetsAt: weekEnd },
      { type: "five_hour", status: null, utilization: 0.02, resetsAt: new Date(Date.now() + 2 * H) }, // 2 %: too small to calibrate
    ]);
    const s = await settingsOf(ws.id);
    const cal = parseUsageCalibration(s);
    expect(cal.workspace?.seven_day).toHaveLength(1);
    expect(cal.workspace!.seven_day![0]).toMatchObject({ spendUsd: 40, utilization: 0.4, windowEnd: weekEnd.toISOString() });
    expect(cal.workspace?.five_hour).toBeUndefined();
    // the other settings keys are kept
    expect((s as { company: unknown }).company).toEqual({ legalName: "PT Kita" });

    // the meter now estimates from the calibration ($1 per percent): 40 % used + a new $5 → 45 %
    await spend(ws.id, emp.id, 5, 60_000);
    const m = await usageMeter(ws.id, "workspace");
    const weekly = m.windows.find((w) => w.type === "seven_day")!;
    // Claude's value is fresh (just reported): it is what is shown, the estimate is returned beside it
    expect(weekly).toMatchObject({ basis: "reported", utilization: 0.4, windowSource: "claude", spendUsd: 45 });
    expect(weekly.estimate).toMatchObject({ basis: "calibrated", points: 1 });
    expect(weekly.estimate!.utilization).toBeCloseTo(0.45);
    // once Claude's value is old, the estimate takes over (the old value stays a floor)
    await db.update(claudeLimits).set({ updatedAt: new Date(Date.now() - 2 * H) }).where(eq(claudeLimits.workspaceId, ws.id));
    const later = (await usageMeter(ws.id, "workspace")).windows.find((w) => w.type === "seven_day")!;
    expect(later).toMatchObject({ basis: "calibrated", reported: { utilization: 0.4, fresh: false } });
    expect(later.utilization).toBeCloseTo(0.45);
  });

  it("a rate_limit_event with utilization calibrates too; one without does not", async () => {
    const { ws, emp } = await oauthWorkspace();
    await spend(ws.id, emp.id, 12, 2 * H);
    const run = { workspaceId: ws.id, taskId: null, employeeId: emp.id, credentialSource: "workspace" as const, credentialType: "oauth" as const };
    const resetsAt = Math.floor((Date.now() + 3 * H) / 1000);
    await recordRateLimit(run, { status: "allowed", rateLimitType: "five_hour", resetsAt });
    expect(parseUsageCalibration(await settingsOf(ws.id)).workspace?.five_hour).toBeUndefined();
    await recordRateLimit(run, { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.6, resetsAt });
    expect(parseUsageCalibration(await settingsOf(ws.id)).workspace!.five_hour![0]).toMatchObject({ spendUsd: 12, utilization: 0.6 });
  });

  it("the estimate never pauses the queue or sends a warning, even near the limit", async () => {
    const { ws, emp } = await oauthWorkspace({ usageBudget: { fiveHourUsd: 10, weeklyUsd: 50 } });
    await spend(ws.id, emp.id, 49, 2 * H);
    // a real report of a low weekly value: no 70/90 % warning, no pause
    await recordUsageWindows(ws.id, "workspace", [{ type: "seven_day", status: null, utilization: 0.1, resetsAt: new Date(Date.now() + 3 * D) }]);
    const m = await usageMeter(ws.id, "workspace");
    const five = m.windows.find((w) => w.type === "five_hour")!;
    expect(five).toMatchObject({ basis: "budget", state: "near", windowSource: "activity" });
    expect(five.utilization).toBeGreaterThan(1);
    expect(notifies().filter((n) => (n.data as { notificationKind?: string }).notificationKind === "limits")).toEqual([]);
    expect((await db.select().from(workspaces).where(eq(workspaces.id, ws.id)))[0]!.quotaPausedUntil).toBeNull();
  });
});

describe("usage meter windows", () => {
  it("without Claude's reset times: the 5-hour window from our runs, the week from the schedule", async () => {
    const { ws, emp } = await oauthWorkspace({ usageBudget: { weeklyUsd: 100, resetDow: 0, resetHour: 0 } });
    await spend(ws.id, emp.id, 3, 30 * 60_000);
    const m = await usageMeter(ws.id, "workspace");
    expect(m.scope).toBe("workforce_os_only");
    expect(m.schedule).toMatchObject({ resetDow: 0, resetHour: 0, timezone: "Asia/Jakarta", source: "custom" });
    const five = m.windows.find((w) => w.type === "five_hour")!;
    expect(five).toMatchObject({ windowSource: "activity", spendUsd: 3, basis: null, state: "unknown" });
    expect(new Date(five.resetsAt!).getTime() - new Date(five.start!).getTime()).toBe(5 * H);
    const weekly = m.windows.find((w) => w.type === "seven_day")!;
    expect(weekly).toMatchObject({ windowSource: "custom", basis: "budget", spendUsd: 3 });
    expect(weekly.utilization).toBeCloseTo(0.03);
    expect(weekly.projectedUsd).toBeGreaterThanOrEqual(3);
  });

  it("derives the weekly schedule from Claude's last weekly reset (production: Sunday 15:00 +08)", async () => {
    const { ws } = await oauthWorkspace();
    await db.update(workspaces).set({ timezone: "Asia/Makassar" }).where(eq(workspaces.id, ws.id));
    await db.insert(claudeLimits).values({ workspaceId: ws.id, credentialSource: "workspace", rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.83, resetsAt: new Date("2026-10-11T15:00:00+08:00") });
    const m = await usageMeter(ws.id, "workspace");
    expect(m.schedule).toEqual({ resetDow: 0, resetHour: 15, timezone: "Asia/Makassar", source: "claude" });
    const weekly = m.windows.find((w) => w.type === "seven_day")!;
    expect(weekly.windowSource).toBe("claude_schedule");
    // the stale 83 % (a past window) is not shown as this window's value
    expect(weekly.reported).toBeNull();
    // no runs: no 5-hour window open
    expect(m.windows.find((w) => w.type === "five_hour")).toMatchObject({ start: null, resetsAt: null, spendUsd: 0 });
  });
});
