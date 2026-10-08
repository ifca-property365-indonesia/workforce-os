import { describe, expect, it } from "vitest";
import { daysBetween, projectHealth, todayIn } from "../src/health";

const JKT = "Asia/Jakarta";
// 2026-10-08 18:30 UTC = 2026-10-09 01:30 in Jakarta (UTC+7)
const NOW = new Date("2026-10-08T18:30:00Z");
const base = { progress: 50, done: false, lastActivityAt: new Date("2026-10-08T10:00:00Z"), createdAt: new Date("2026-09-01T00:00:00Z") };

describe("project health", () => {
  it("does date math in the workspace time zone", () => {
    expect(todayIn(JKT, NOW)).toBe("2026-10-09");
    expect(todayIn("UTC", NOW)).toBe("2026-10-08");
    expect(daysBetween("2026-10-09", "2026-10-23")).toBe(14);
    // deadline 2026-10-08 is already past in Jakarta, but still today in UTC
    expect(projectHealth({ ...base, deadline: "2026-10-08" }, JKT, NOW).health).toBe("late");
    expect(projectHealth({ ...base, deadline: "2026-10-08", progress: 90 }, "UTC", NOW).health).toBe("on_track");
  });

  it("late = past deadline and not done", () => {
    expect(projectHealth({ ...base, deadline: "2026-10-01", progress: 99 }, JKT, NOW)).toMatchObject({ health: "late", reasons: ["past_deadline"] });
    expect(projectHealth({ ...base, deadline: "2026-10-01", done: true }, JKT, NOW).health).toBe("done");
  });

  it("at risk = deadline in < 14 days with progress < 70", () => {
    expect(projectHealth({ ...base, deadline: "2026-10-22", progress: 69 }, JKT, NOW).health).toBe("at_risk"); // 13 days
    expect(projectHealth({ ...base, deadline: "2026-10-22", progress: 70 }, JKT, NOW).health).toBe("on_track");
    expect(projectHealth({ ...base, deadline: "2026-10-23", progress: 10 }, JKT, NOW).health).toBe("on_track"); // 14 days
  });

  it("at risk = no activity in 7 days", () => {
    expect(projectHealth({ ...base, deadline: null, lastActivityAt: new Date("2026-10-01T18:00:00Z") }, JKT, NOW)).toMatchObject({ health: "at_risk", reasons: ["no_activity"], idleDays: 7 });
    expect(projectHealth({ ...base, deadline: null, lastActivityAt: new Date("2026-10-02T18:00:00Z") }, JKT, NOW).health).toBe("on_track");
    expect(projectHealth({ ...base, deadline: null, lastActivityAt: null, createdAt: new Date("2026-09-01T00:00:00Z") }, JKT, NOW).health).toBe("at_risk");
  });
});
