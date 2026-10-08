import { describe, expect, it } from "vitest";
import { newWarning, normalizeRateLimit } from "../src/limits";

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
