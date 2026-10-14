import { describe, expect, it } from "vitest";
import { isWithinReleaseWindow, releaseWindowSchema } from "../src/index";

// 2026-10-14 is a Wednesday (day 3); Asia/Jakarta is UTC+7
const at = (iso: string) => new Date(iso);

describe("isWithinReleaseWindow", () => {
  it("a same-day window: start inclusive, end exclusive, only on its days", () => {
    const w = releaseWindowSchema.parse({ days: [3], start: "09:00", end: "17:00" });
    expect(isWithinReleaseWindow(w, at("2026-10-14T02:00:00Z"))).toBe(true); // 09:00 WIB
    expect(isWithinReleaseWindow(w, at("2026-10-14T09:59:00Z"))).toBe(true); // 16:59
    expect(isWithinReleaseWindow(w, at("2026-10-14T10:00:00Z"))).toBe(false); // 17:00
    expect(isWithinReleaseWindow(w, at("2026-10-15T02:00:00Z"))).toBe(false); // Thursday
  });

  it("an overnight window counts from the day it starts", () => {
    const w = releaseWindowSchema.parse({ days: [3], start: "22:00", end: "05:00" });
    expect(isWithinReleaseWindow(w, at("2026-10-14T15:30:00Z"))).toBe(true); // Wed 22:30 WIB
    expect(isWithinReleaseWindow(w, at("2026-10-14T21:00:00Z"))).toBe(true); // Thu 04:00 WIB, window of Wed
    expect(isWithinReleaseWindow(w, at("2026-10-14T22:00:00Z"))).toBe(false); // Thu 05:00
    expect(isWithinReleaseWindow(w, at("2026-10-13T21:00:00Z"))).toBe(false); // Wed 04:00: window of Tue, not allowed
    expect(isWithinReleaseWindow(w, at("2026-10-14T12:00:00Z"))).toBe(false); // Wed 19:00
  });

  it("validates times and days", () => {
    expect(releaseWindowSchema.safeParse({ start: "24:00", end: "05:00" }).success).toBe(false);
    expect(releaseWindowSchema.safeParse({ days: [], start: "22:00", end: "05:00" }).success).toBe(false);
    expect(releaseWindowSchema.parse({ start: "22:00", end: "05:00" }).days).toHaveLength(7);
  });
});
