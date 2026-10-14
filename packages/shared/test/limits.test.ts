import { describe, expect, it } from "vitest";
import { displayWindow, newWarning, normalizeRateLimit, sameWindow, usageStatus, usageWindows, windowExpired } from "../src/limits";

describe("subscription limit events", () => {
  it("normalises seconds/ms timestamps and fraction/percent utilization", () => {
    const a = normalizeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1_791_400_000 })!;
    expect(a.utilization).toBe(0.42);
    expect(a.resetsAt!.toISOString()).toBe(new Date(1_791_400_000_000).toISOString());
    const b = normalizeRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 87, resetsAt: 1_791_400_000_000 })!;
    expect(b.utilization).toBe(0.87);
    expect(b.resetsAt!.getTime()).toBe(1_791_400_000_000);
  });

  it("treats a rejection without utilization as full and defaults the window", () => {
    expect(normalizeRateLimit({ status: "rejected" })).toEqual({ type: "five_hour", status: "rejected", utilization: 1, resetsAt: null });
    expect(normalizeRateLimit({})).toBeNull();
    expect(normalizeRateLimit({ status: "weird", utilization: -3 })!.utilization).toBe(0);
  });

  it("warns once at 70% and once at 90%", () => {
    expect(newWarning(0.5, 0)).toBe(0);
    expect(newWarning(0.71, 0)).toBe(70);
    expect(newWarning(0.75, 70)).toBe(0);
    expect(newWarning(0.93, 70)).toBe(90);
    expect(newWarning(0.95, 0)).toBe(90);
    expect(newWarning(0.99, 90)).toBe(0);
    expect(newWarning(null, 0)).toBe(0);
  });
});

describe("usage endpoint windows (the SDK's experimental usage call)", () => {
  const full = {
    session: { total_cost_usd: 0 },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12.5, resets_at: "2026-10-15T03:00:00+00:00" },
      seven_day: { utilization: 83, resets_at: "2026-10-18T07:00:00.123456+00:00" },
      seven_day_oauth_apps: null,
      seven_day_opus: { utilization: null, resets_at: null },
      seven_day_sonnet: { utilization: 3, resets_at: "2026-10-18T07:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 150, resets_at: "2026-10-18T07:00:00Z" }, { display_name: "", utilization: 1, resets_at: null }, null],
      extra_usage: { is_enabled: false },
    },
  };

  it("maps percent to a 0..1 fraction, ISO to dates, and per-model windows to seven_day_model:<name>", () => {
    const w = usageWindows(full);
    expect(w.map((x) => [x.type, x.utilization, x.resetsAt?.toISOString() ?? null, x.status])).toEqual([
      ["five_hour", 0.125, "2026-10-15T03:00:00.000Z", null],
      ["seven_day", 0.83, "2026-10-18T07:00:00.123Z", null],
      ["seven_day_sonnet", 0.03, "2026-10-18T07:00:00.000Z", null],
      ["seven_day_model:Fable", 1, "2026-10-18T07:00:00.000Z", null],
    ]);
  });

  it("missing fields, no plan limits, or a malformed answer: nothing (never throws)", () => {
    expect(usageWindows({ rate_limits_available: false, rate_limits: null })).toEqual([]);
    expect(usageWindows({ rate_limits_available: true, rate_limits: null })).toEqual([]);
    expect(usageWindows({ rate_limits_available: true, rate_limits: {} })).toEqual([]);
    expect(usageWindows({ rate_limits: { five_hour: { utilization: "12" , resets_at: "not a date" } } })).toEqual([]);
    expect(usageWindows({ rate_limits: { five_hour: { utilization: 40 } } })).toEqual([{ type: "five_hour", status: null, utilization: 0.4, resetsAt: null }]);
    expect(usageWindows(null)).toEqual([]);
    expect(usageWindows("x")).toEqual([]);
    const hostile = { get rate_limits() { throw new Error("boom"); } };
    expect(usageWindows(hostile)).toEqual([]);
  });

  it("derives a status from utilization (70 % warns, 100 % rejected), keeping a same-window warning", () => {
    expect(usageStatus(0.1, null)).toBe("allowed");
    expect(usageStatus(0.7, null)).toBe("allowed_warning");
    expect(usageStatus(1, null)).toBe("rejected");
    expect(usageStatus(0.5, { status: "allowed_warning", sameWindow: true })).toBe("allowed_warning");
    expect(usageStatus(0.5, { status: "allowed_warning", sameWindow: false })).toBe("allowed");
    expect(usageStatus(null, { status: "rejected", sameWindow: true })).toBe("rejected");
    expect(usageStatus(null, { status: "rejected", sameWindow: false })).toBe("allowed");
  });

  it("same window within 30 minutes of the reset time; expired windows show no old numbers", () => {
    const a = new Date("2026-10-18T07:00:00Z");
    expect(sameWindow(a, new Date("2026-10-18T07:00:00.500Z"))).toBe(true);
    expect(sameWindow(a, new Date("2026-10-18T12:00:00Z"))).toBe(false);
    expect(sameWindow(a, null)).toBe(false);
    const now = new Date("2026-10-15T01:00:00Z");
    // the production row: weekly 83 %, reset 2026-10-11 (past)
    const stale = { type: "seven_day", status: "allowed_warning", utilization: 0.83, resetsAt: "2026-10-11T07:00:00.000Z" };
    expect(windowExpired(stale.resetsAt, now)).toBe(true);
    expect(displayWindow(stale, now)).toEqual({ ...stale, status: "allowed", utilization: null, expired: true });
    const live = { type: "five_hour", status: "allowed", utilization: 0.2, resetsAt: "2026-10-15T03:00:00.000Z" };
    expect(displayWindow(live, now)).toEqual({ ...live, expired: false });
    expect(displayWindow({ ...live, resetsAt: null }, now).expired).toBe(false);
  });
});
