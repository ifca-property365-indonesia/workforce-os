import { describe, expect, it } from "vitest";
import { heartbeat } from "../src/lib/heartbeat";

describe("worker heartbeat", () => {
  it("reports pid, commit, active runs and sandbox readiness", async () => {
    const hb = await heartbeat();
    expect(hb.pid).toBe(process.pid);
    expect(Date.now() - Date.parse(hb.at)).toBeLessThan(5000);
    expect(hb.activeRuns).toBe(0);
    expect(hb.sandbox).toEqual({ available: expect.any(Boolean), runner: expect.any(Boolean), claude: expect.any(Boolean) });
    expect(hb.commit === null || /^[0-9a-f]{7,40}$/.test(hb.commit)).toBe(true);
  });
});
