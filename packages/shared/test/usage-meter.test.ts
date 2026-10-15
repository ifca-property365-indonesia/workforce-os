import { describe, expect, it } from "vitest";
import {
  addCalibrationPoint,
  calibrationPoint,
  estimateWindow,
  fiveHourWindow,
  parseUsageBudget,
  resolveSchedule,
  scheduleOf,
  sevenDayWindow,
  tzOffsetMs,
  usageBudgetSchema,
  usageState,
  usdPerPercent,
  weekWindow,
  type CalibrationPoint,
  type EstimateInput,
} from "../src/usage-meter";

const H = 3_600_000;
const D = 24 * H;
const at = (iso: string) => new Date(iso);
const AUTO = { resetDow: null, resetHour: null, timezone: null };

describe("time zones", () => {
  it("offsets: Jakarta +7, Makassar +8, New York switches at the end of DST", () => {
    expect(tzOffsetMs("Asia/Jakarta", at("2026-10-11T07:00:00Z"))).toBe(7 * H);
    expect(tzOffsetMs("Asia/Makassar", at("2026-10-11T07:00:00Z"))).toBe(8 * H);
    expect(tzOffsetMs("America/New_York", at("2026-10-31T12:00:00Z"))).toBe(-4 * H);
    expect(tzOffsetMs("America/New_York", at("2026-11-02T12:00:00Z"))).toBe(-5 * H);
  });
});

describe("reset schedule", () => {
  // production: seven_day resets_at 2026-10-11 15:00+08
  const prod = at("2026-10-11T15:00:00+08:00");

  it("derives the default from Claude's last weekly reset, in the workspace time zone", () => {
    expect(resolveSchedule(AUTO, prod, "Asia/Jakarta")).toEqual({ resetDow: 0, resetHour: 14, timezone: "Asia/Jakarta", source: "claude" });
    expect(resolveSchedule(AUTO, prod, "Asia/Makassar")).toEqual({ resetDow: 0, resetHour: 15, timezone: "Asia/Makassar", source: "claude" });
    // the budget's own zone wins over the workspace's
    expect(resolveSchedule({ ...AUTO, timezone: "UTC" }, prod, "Asia/Jakarta")).toMatchObject({ resetDow: 0, resetHour: 7, timezone: "UTC" });
  });

  it("rounds a reset just before the hour to that hour (across midnight too)", () => {
    expect(scheduleOf(at("2026-10-11T14:59:58+07:00"), "Asia/Jakarta")).toEqual({ resetDow: 0, resetHour: 15 });
    expect(scheduleOf(at("2026-10-10T23:59:30+07:00"), "Asia/Jakarta")).toEqual({ resetDow: 0, resetHour: 0 });
    expect(scheduleOf(at("2026-10-11T15:20:00+07:00"), "Asia/Jakarta")).toEqual({ resetDow: 0, resetHour: 15 });
  });

  it("Sunday 00:00 without any weekly reset; the owner's schedule only when both day and hour are set", () => {
    expect(resolveSchedule(AUTO, null, "Asia/Jakarta")).toEqual({ resetDow: 0, resetHour: 0, timezone: "Asia/Jakarta", source: "default" });
    expect(resolveSchedule({ resetDow: 3, resetHour: 9, timezone: null }, prod, "Asia/Jakarta")).toEqual({ resetDow: 3, resetHour: 9, timezone: "Asia/Jakarta", source: "custom" });
    expect(resolveSchedule({ resetDow: 3, resetHour: null, timezone: null }, prod, "Asia/Jakarta").source).toBe("claude");
    // an unknown workspace zone falls back to UTC instead of throwing
    expect(resolveSchedule(AUTO, null, "Mars/Olympus").timezone).toBe("UTC");
  });
});

describe("weekly window", () => {
  const sun14 = { resetDow: 0, resetHour: 14, timezone: "Asia/Jakarta" };

  it("starts at the last reset at or before now and lasts a week", () => {
    const w = weekWindow(at("2026-10-14T10:00:00+07:00"), sun14);
    expect(w.start.toISOString()).toBe("2026-10-11T07:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-18T07:00:00.000Z");
    expect(w.source).toBe("schedule");
  });

  it("on the reset day: before the hour is still last week, at the hour a new week starts", () => {
    expect(weekWindow(at("2026-10-18T13:59:00+07:00"), sun14).start.toISOString()).toBe("2026-10-11T07:00:00.000Z");
    expect(weekWindow(at("2026-10-18T14:00:00+07:00"), sun14).start.toISOString()).toBe("2026-10-18T07:00:00.000Z");
    // Saturday night: still the week that started last Sunday
    expect(weekWindow(at("2026-10-17T23:00:00+07:00"), sun14).end.toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });

  it("keeps the wall-clock reset across a DST change", () => {
    const w = weekWindow(at("2026-11-03T12:00:00Z"), { resetDow: 0, resetHour: 0, timezone: "America/New_York" });
    expect(w.start.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // midnight EDT
    expect(w.end.toISOString()).toBe("2026-11-08T05:00:00.000Z"); // midnight EST
  });

  it("Claude's live reset time wins over the schedule; a past or implausible one does not", () => {
    const now = at("2026-10-14T03:00:00Z");
    const schedule = { ...sun14, source: "custom" as const };
    const live = sevenDayWindow(now, schedule, at("2026-10-16T05:00:00Z"));
    expect(live).toEqual({ start: at("2026-10-09T05:00:00Z"), end: at("2026-10-16T05:00:00Z"), source: "claude" });
    expect(sevenDayWindow(now, schedule, at("2026-10-13T05:00:00Z")).source).toBe("schedule");
    expect(sevenDayWindow(now, schedule, at("2026-10-30T05:00:00Z")).source).toBe("schedule");
  });
});

describe("5-hour window", () => {
  const now = at("2026-10-14T12:30:00Z");
  /** activity at these instants: the first at or after `from` */
  const activity = (times: string[]) => async (from: Date) => times.map(at).find((t) => t.getTime() >= from.getTime()) ?? null;

  it("Claude's live reset time when known", async () => {
    const w = await fiveHourWindow(now, at("2026-10-14T15:00:00Z"), activity([]));
    expect(w).toEqual({ start: at("2026-10-14T10:00:00Z"), end: at("2026-10-14T15:00:00Z"), source: "claude" });
  });

  it("else opened by the first run after the previous window ended, on the hour", async () => {
    const w = await fiveHourWindow(now, at("2026-10-14T06:00:00Z"), activity(["2026-10-14T09:40:00Z", "2026-10-14T12:00:00Z"]));
    expect(w).toEqual({ start: at("2026-10-14T09:00:00Z"), end: at("2026-10-14T14:00:00Z"), source: "activity" });
  });

  it("chains windows: a window that has ended is followed by the next run's", async () => {
    // 01:10 opens 01:00–06:00; 06:20 opens 06:00–11:00; 11:05 opens 11:00–16:00 (current)
    const w = await fiveHourWindow(now, null, activity(["2026-10-14T01:10:00Z", "2026-10-14T06:20:00Z", "2026-10-14T11:05:00Z"]));
    expect(w?.start.toISOString()).toBe("2026-10-14T11:00:00.000Z");
  });

  it("no window open when nothing ran since the last one ended", async () => {
    expect(await fiveHourWindow(now, null, activity(["2026-10-14T01:10:00Z"]))).toBeNull();
    expect(await fiveHourWindow(now, null, activity([]))).toBeNull();
  });
});

describe("calibration", () => {
  const now = at("2026-10-14T12:00:00Z");
  const end = at("2026-10-18T07:00:00Z");

  it("a point is our spend over the reported utilization; edge cases give none", () => {
    expect(calibrationPoint(20, 0.4, now, end)).toEqual({ at: now.toISOString(), windowEnd: end.toISOString(), spendUsd: 20, utilization: 0.4 });
    expect(calibrationPoint(20, 0, now, end)).toBeNull(); // utilization 0: no ratio
    expect(calibrationPoint(20, 0.01, now, end)).toBeNull(); // 1 %: rounding noise
    expect(calibrationPoint(0.1, 0.5, now, end)).toBeNull(); // tiny spend: the usage was not ours
    expect(calibrationPoint(0, 0.5, now, end)).toBeNull();
    expect(calibrationPoint(20, null, now, end)).toBeNull();
    expect(calibrationPoint(Number.NaN, 0.5, now, end)).toBeNull();
    expect(calibrationPoint(20, 1.5, now, end)).toBeNull();
  });

  it("usdPerPercent is total spend over total percent of the recent points", () => {
    const pts: CalibrationPoint[] = [
      { at: "2026-10-01T00:00:00Z", windowEnd: "2026-10-04T07:00:00Z", spendUsd: 30, utilization: 0.5 },
      { at: "2026-10-10T00:00:00Z", windowEnd: "2026-10-11T07:00:00Z", spendUsd: 10, utilization: 0.3 },
    ];
    expect(usdPerPercent(pts, now)).toEqual({ usdPerPercent: 0.5, points: 2, latestAt: "2026-10-10T00:00:00Z" });
    expect(usdPerPercent([], now)).toBeNull();
    expect(usdPerPercent("junk", now)).toBeNull();
    // points older than 28 days are dropped
    expect(usdPerPercent([{ ...pts[0]!, at: "2026-09-01T00:00:00Z" }], now)).toBeNull();
  });

  it("one point per window (a later report replaces it), throttled, at most five", () => {
    const p1 = calibrationPoint(10, 0.2, at("2026-10-14T10:00:00Z"), end)!;
    let list = addCalibrationPoint([], p1, now)!;
    expect(list).toHaveLength(1);
    // the same window 30 s later: ignored
    expect(addCalibrationPoint(list, calibrationPoint(11, 0.21, at("2026-10-14T10:00:30Z"), end)!, now)).toBeNull();
    // the same window an hour later (reset time rounded differently): replaces
    list = addCalibrationPoint(list, calibrationPoint(15, 0.3, at("2026-10-14T11:00:00Z"), new Date(end.getTime() + 60_000))!, now)!;
    expect(list.map((p) => p.spendUsd)).toEqual([15]);
    // other windows add up to five, oldest dropped
    for (let i = 1; i <= 6; i++) {
      const t = new Date(now.getTime() - i * D);
      list = addCalibrationPoint(list, calibrationPoint(5 + i, 0.1, t, new Date(t.getTime() + 3 * D - i * 7 * D))!, now)!;
    }
    expect(list).toHaveLength(5);
    expect(list[list.length - 1]!.spendUsd).toBe(15);
  });
});

describe("estimate and precedence", () => {
  const now = at("2026-10-14T07:00:00Z");
  const week = { start: at("2026-10-11T07:00:00Z"), end: at("2026-10-18T07:00:00Z"), source: "schedule" as const };
  const cal: CalibrationPoint[] = [{ at: "2026-10-10T00:00:00Z", windowEnd: "2026-10-11T07:00:00Z", spendUsd: 50, utilization: 0.5 }]; // $1 per %
  const base: EstimateInput = { type: "seven_day", now, window: week, scheduleSource: "claude", spendUsd: 30, points: [], budgetUsd: null, row: null };

  it("calibrated first", () => {
    const m = estimateWindow({ ...base, points: cal, budgetUsd: 1000 });
    expect(m.basis).toBe("calibrated");
    expect(m.utilization).toBeCloseTo(0.3);
    expect(m.estimate).toMatchObject({ basis: "calibrated", calibratedAt: "2026-10-10T00:00:00Z", usdPerPercent: 1, points: 1 });
    expect(m.windowSource).toBe("claude_schedule");
  });

  it("the owner's budget without calibration", () => {
    const m = estimateWindow({ ...base, budgetUsd: 200 });
    expect(m.basis).toBe("budget");
    expect(m.utilization).toBeCloseTo(0.15);
    expect(m.estimate).toMatchObject({ basis: "budget", budgetUsd: 200 });
  });

  it("neither: only the spend", () => {
    const m = estimateWindow(base);
    expect(m).toMatchObject({ basis: null, utilization: null, estimate: null, state: "unknown", spendUsd: 30 });
    expect(m.projectedUsd).toBe(70); // 3 of 7 days elapsed
  });

  it("a fresh real value overrides the estimate; a stale one is only a floor", () => {
    const row = { utilization: 0.6, status: "allowed", resetsAt: week.end, updatedAt: new Date(now.getTime() - 10 * 60_000) };
    const fresh = estimateWindow({ ...base, points: cal, row });
    expect(fresh).toMatchObject({ basis: "reported", utilization: 0.6, reported: { utilization: 0.6, fresh: true } });
    expect(fresh.estimate?.utilization).toBeCloseTo(0.3); // still returned
    const stale = estimateWindow({ ...base, points: cal, row: { ...row, updatedAt: new Date(now.getTime() - 3 * H) } });
    expect(stale).toMatchObject({ basis: "calibrated", utilization: 0.6, reported: { fresh: false } });
    // a row of a past window is not this window's value
    const old = estimateWindow({ ...base, points: cal, row: { ...row, resetsAt: new Date(now.getTime() - D) } });
    expect(old.reported).toBeNull();
    expect(old.utilization).toBeCloseTo(0.3);
  });

  it("states: watch from 80 % or a projection over the limit, near from 95 % or a fresh rejection", () => {
    expect(estimateWindow({ ...base, points: cal, spendUsd: 20 }).state).toBe("safe"); // 20 %, projected 47 %
    expect(estimateWindow({ ...base, points: cal, spendUsd: 50 }).state).toBe("watch"); // 50 %, projected 117 %
    expect(estimateWindow({ ...base, points: cal, spendUsd: 85 }).state).toBe("watch");
    expect(estimateWindow({ ...base, points: cal, spendUsd: 96 }).state).toBe("near");
    const rejected = { utilization: 1, status: "rejected", resetsAt: week.end, updatedAt: now };
    expect(estimateWindow({ ...base, row: rejected }).state).toBe("near");
    expect(usageState(null, null, false)).toBe("unknown");
  });

  it("the projection never extrapolates from less than 12 hours", () => {
    const early = { ...week, start: new Date(now.getTime() - H), end: new Date(now.getTime() + 7 * D - H) };
    const m = estimateWindow({ ...base, window: early, spendUsd: 5, points: cal });
    expect(m.projectedUsd).toBe(70); // 5 × (168 / 12), not 5 × 168
    expect(m.projectedUtilization).toBeCloseTo(0.7);
  });

  it("5-hour: no projection; a window not open yet has no spend and no reset", () => {
    const m = estimateWindow({ ...base, type: "five_hour", window: null, spendUsd: 0, budgetUsd: 10 });
    expect(m).toMatchObject({ start: null, resetsAt: null, windowSource: null, projectedUsd: null, utilization: 0, state: "safe" });
  });
});

describe("usage budget settings", () => {
  it("defaults to no budget and an automatic schedule; validates", () => {
    expect(parseUsageBudget({})).toEqual({ weeklyUsd: null, fiveHourUsd: null, resetDow: null, resetHour: null, timezone: null });
    expect(parseUsageBudget({ usageBudget: { weeklyUsd: 150, resetDow: 0, resetHour: 14 } })).toMatchObject({ weeklyUsd: 150, resetDow: 0, resetHour: 14 });
    expect(parseUsageBudget({ usageBudget: { weeklyUsd: -1 } }).weeklyUsd).toBeNull();
    expect(usageBudgetSchema.safeParse({ resetDow: 7 }).success).toBe(false);
    expect(usageBudgetSchema.safeParse({ resetHour: 24 }).success).toBe(false);
    expect(usageBudgetSchema.safeParse({ timezone: "Nope/Nowhere" }).success).toBe(false);
    expect(usageBudgetSchema.safeParse({ timezone: "Asia/Makassar" }).success).toBe(true);
  });
});
