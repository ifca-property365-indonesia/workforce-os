import { describe, expect, it } from "vitest";
import { evaluateHealth, heartbeatKey, HEARTBEAT_STALE_MS, type WorkerHeartbeat } from "../src/ops";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const hb = (ageMs: number, sandbox = { available: true, runner: true, claude: true }): WorkerHeartbeat => ({
  at: new Date(NOW - ageMs).toISOString(),
  pid: 1,
  commit: "abc1234",
  activeRuns: 0,
  sandbox,
});

describe("health verdict", () => {
  it("ok when db, redis and a fresh worker heartbeat are there", () => {
    const r = evaluateHealth({ db: true, redis: true, heartbeat: hb(5000), workspaceModeInUse: false, now: NOW });
    expect(r.status).toBe("ok");
    expect(r.checks.worker).toEqual({ ok: true, ageSec: 5, activeRuns: 0 });
    expect(r.commit).toBe("abc1234");
  });
  it("down when the database or redis is unreachable", () => {
    expect(evaluateHealth({ db: false, redis: true, heartbeat: hb(0), workspaceModeInUse: false, now: NOW }).status).toBe("down");
    expect(evaluateHealth({ db: true, redis: false, heartbeat: null, workspaceModeInUse: false, now: NOW }).status).toBe("down");
  });
  it("degraded without a worker, or with a stale heartbeat", () => {
    expect(evaluateHealth({ db: true, redis: true, heartbeat: null, workspaceModeInUse: false, now: NOW }).status).toBe("degraded");
    expect(evaluateHealth({ db: true, redis: true, heartbeat: hb(HEARTBEAT_STALE_MS + 1000), workspaceModeInUse: false, now: NOW }).status).toBe("degraded");
  });
  it("a missing sandbox degrades only when Workspace mode is in use", () => {
    const noSandbox = hb(1000, { available: false, runner: true, claude: true });
    expect(evaluateHealth({ db: true, redis: true, heartbeat: noSandbox, workspaceModeInUse: false, now: NOW }).status).toBe("ok");
    const r = evaluateHealth({ db: true, redis: true, heartbeat: noSandbox, workspaceModeInUse: true, now: NOW });
    expect(r.status).toBe("degraded");
    expect(r.checks.sandbox).toEqual({ ok: false, required: true, runner: true, claude: true });
    expect(evaluateHealth({ db: true, redis: true, heartbeat: hb(1000, { available: true, runner: false, claude: true }), workspaceModeInUse: true, now: NOW }).status).toBe("degraded");
  });
  it("heartbeat key follows the instance namespace", () => {
    expect(heartbeatKey()).toBe("wfos:health:worker");
    expect(heartbeatKey("wfos-dev")).toBe("wfos-dev:wfos:health:worker");
  });
});
