import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, employees, workspaces } from "@wfos/db";
import { heartbeatKey } from "@wfos/shared/ops";
import { GET as health } from "@/app/api/health/route";
import { call, kv, redisState, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

const beat = (ageMs: number, available = true) =>
  kv.set(heartbeatKey("wfos-test"), JSON.stringify({ at: new Date(Date.now() - ageMs).toISOString(), pid: 1, commit: "abc123", activeRuns: 0, sandbox: { available, runner: true, claude: true } }));

describe("/api/health", () => {
  it("is degraded (200) without a worker heartbeat, and 503 with ?strict=1", async () => {
    const r = await call(health, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false, status: "degraded", checks: { db: true, redis: true, worker: { ok: false, ageSec: null } } });
    expect((await call(health, "GET", "/api/health?strict=1")).status).toBe(503);
  });

  it("is ok with a fresh heartbeat and reports the worker's commit", async () => {
    beat(3000);
    const r = await call(health, "GET", "/api/health?strict=1");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, status: "ok", commit: "abc123" });
  });

  it("a stale heartbeat means the worker is down", async () => {
    beat(10 * 60_000);
    expect((await call(health, "GET", "/api/health")).json.status).toBe("degraded");
  });

  it("a missing sandbox degrades once a Workspace-mode employee exists", async () => {
    beat(1000, false);
    const [ws] = await db.insert(workspaces).values({ name: "H", slug: `h-${randomUUID().slice(0, 8)}` }).returning();
    await db.insert(employees).values({ workspaceId: ws!.id, name: "Dev", role: "Developer", model: "m", executionMode: "workspace" });
    const r = await call(health, "GET", "/api/health?strict=1");
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ status: "degraded", checks: { sandbox: { ok: false, required: true } } });
  });

  it("is down (503) when redis is unreachable, without leaking error details", async () => {
    redisState.down = true;
    const r = await call(health, "GET", "/api/health");
    expect(r.status).toBe(503);
    expect(r.json.status).toBe("down");
    expect(JSON.stringify(r.json)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });
});
