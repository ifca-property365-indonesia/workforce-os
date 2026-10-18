import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, employees, incidents, steps, tasks } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setWorkspaceSliceMs } from "../src/runner/executor";
import { setQueryImpl, setWorkspaceQueryFactory, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { redis } from "../src/lib/redis";
import { env } from "../src/lib/env";
import {
  LEASE_TTL_MS,
  acquireWorkspaceSlot,
  memoryAdmits,
  releaseWorkspaceSlot,
  renewWorkspaceSlot,
  setHostProbe,
  tasksWaitingForSlot,
} from "../src/runner/workspace/slots";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

const WAITING_KEY = `${env.namespace ? `${env.namespace}:` : ""}wfos:workspace-waiting`;
const LIMIT_SEC = env.workspaceTaskMaxHours * 3600;

beforeEach(() => {
  resetTransport();
  delete process.env.WORKSPACE_CONCURRENCY;
});
afterEach(() => {
  setQueryImpl(null);
  setWorkspaceQueryFactory(null);
  setWorkspaceSliceMs(null);
  setHostProbe(null);
  delete process.env.WORKSPACE_CONCURRENCY;
  vi.useRealTimers();
});

/** A host with `availableMb` free and the given memory in use per sandbox run. */
const host = (availableMb: number, usedMb: Record<string, number> = {}) => setHostProbe({ availableMb: async () => availableMb, unitCurrentMb: async (id) => usedMb[id] ?? null });
const slot = (runId: string, taskId = `task-${runId}`, memoryMaxMb = 2048) => acquireWorkspaceSlot({ runId, taskId, memoryMaxMb });

describe("sandbox admission: memory", () => {
  it("the first sandbox always starts; a further one needs its limit plus the reserve after what running ones may still grow into", () => {
    expect(memoryAdmits({ availableMb: 100, reserveMb: 1024, needMb: 2048, others: [] })).toBe(true);
    // 8000 free, the running sandbox uses 500 of 2048: it may grow 1548 more → 6452 left ≥ 2048 + 1024
    expect(memoryAdmits({ availableMb: 8000, reserveMb: 1024, needMb: 2048, others: [{ maxMb: 2048, currentMb: 500 }] })).toBe(true);
    // the same with only 4000 free: 2452 left < 3072
    expect(memoryAdmits({ availableMb: 4000, reserveMb: 1024, needMb: 2048, others: [{ maxMb: 2048, currentMb: 500 }] })).toBe(false);
    // a sandbox whose unit has not started yet counts at its full limit
    expect(memoryAdmits({ availableMb: 5000, reserveMb: 1024, needMb: 2048, others: [{ maxMb: 2048, currentMb: null }] })).toBe(false);
    expect(memoryAdmits({ availableMb: 5200, reserveMb: 1024, needMb: 2048, others: [{ maxMb: 2048, currentMb: null }] })).toBe(true);
  });
});

describe("sandbox slots", () => {
  it("at most WORKSPACE_CONCURRENCY sandboxes (default 1); a release frees the slot", async () => {
    expect(await slot("run-a")).toEqual({ ok: true });
    expect(await slot("run-b")).toMatchObject({ ok: false, reason: "slots" });
    await releaseWorkspaceSlot("run-a");
    expect(await slot("run-b")).toEqual({ ok: true });
  });

  it("with WORKSPACE_CONCURRENCY=2 the second sandbox starts only when the memory is there", async () => {
    process.env.WORKSPACE_CONCURRENCY = "2";
    host(4000, { "run-a": 300 });
    expect(await slot("run-a")).toEqual({ ok: true });
    expect(await slot("run-b")).toMatchObject({ ok: false, reason: "memory" });
    host(9000, { "run-a": 300 });
    expect(await slot("run-b")).toEqual({ ok: true });
    // two running: the third is refused by the count before any memory is read
    host(1_000_000);
    expect(await slot("run-c")).toMatchObject({ ok: false, reason: "slots" });
  });

  it("a refused task is waiting: firstWait only on its first refusal, and it is no longer waiting once admitted", async () => {
    await slot("run-a");
    expect(await slot("run-b", "task-b")).toMatchObject({ ok: false, firstWait: true });
    expect(await slot("run-b2", "task-b")).toMatchObject({ ok: false, firstWait: false });
    expect(await tasksWaitingForSlot()).toBe(1);
    expect(await tasksWaitingForSlot("task-b")).toBe(0);
    await releaseWorkspaceSlot("run-a");
    expect(await slot("run-b3", "task-b")).toEqual({ ok: true });
    expect(await tasksWaitingForSlot()).toBe(0);
  });

  it("a lease the run keeps renewing outlives the TTL; an abandoned one (crashed worker) expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await slot("run-a");
    vi.setSystemTime(Date.now() + LEASE_TTL_MS - 1000);
    await renewWorkspaceSlot("run-a");
    vi.setSystemTime(Date.now() + LEASE_TTL_MS - 1000);
    expect(await slot("run-b")).toMatchObject({ ok: false, reason: "slots" });
    // no renewal any more
    vi.setSystemTime(Date.now() + LEASE_TTL_MS + 1000);
    expect(await slot("run-b")).toEqual({ ok: true });
  });

  it("renewing a released lease does not bring it back", async () => {
    await slot("run-a");
    await releaseWorkspaceSlot("run-a");
    await renewWorkspaceSlot("run-a");
    expect(await slot("run-b")).toEqual({ ok: true });
  });
});

async function workspaceTask(over: Partial<typeof tasks.$inferInsert> = {}) {
  const ws = await makeWorkspace();
  const e = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const [emp] = await db.update(employees).set({ executionMode: "workspace" }).where(eq(employees.id, e.id)).returning();
  const task = await makeTask(ws.id, emp!.id, over);
  return { ws, emp: emp!, task };
}
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const stepsNamed = (taskId: string, name: string) => db.select().from(steps).where(and(eq(steps.taskId, taskId), eq(steps.name, name)));
const runWith = (script: MockStep[]) => {
  const mock = mockRunner(script);
  setWorkspaceQueryFactory(() => mock.query as QueryFn);
  return mock;
};

describe("Workspace-mode run time", () => {
  it("past its slice, a run hands the sandbox to a waiting task and resumes later in the same session", async () => {
    const { task } = await workspaceTask();
    setWorkspaceSliceMs(1000);
    await redis.zadd(WAITING_KEY, Date.now(), "another-task");
    const mock = runWith([{ llm: { input: 10, output: 10 } }, { wait: 5_000 }, { result: "never" }]);
    const t0 = Date.now();
    await runTask(task.id);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(mock.started).toBe(1);

    const t = await row(task.id);
    expect(t).toMatchObject({ status: "QUEUED", error: null });
    expect(t.sandboxSeconds).toBeGreaterThanOrEqual(1);
    expect(await stepsNamed(task.id, "workspace_yielded")).toHaveLength(1);
    const again = transport.queued.filter((q) => (q.data as { taskId?: string }).taskId === task.id);
    expect(again).toHaveLength(1);
    expect(again[0]!.opts?.delay).toBe(20_000);
    expect((again[0]!.data as { resumeNote: string }).resumeNote).toMatch(/another task could use the sandbox/);
  });

  it("with nobody waiting the run keeps going past its slice", async () => {
    const { task } = await workspaceTask();
    setWorkspaceSliceMs(20);
    runWith([{ llm: { input: 10, output: 10 } }, { wait: 200 }, { result: "done" }]);
    await runTask(task.id);
    expect(await row(task.id)).toMatchObject({ status: "DONE", result: "done" });
    expect(await stepsNamed(task.id, "workspace_yielded")).toHaveLength(0);
  });

  it("a tool call in flight is never cut for a hand-over: the run yields after it", async () => {
    const { task } = await workspaceTask();
    setWorkspaceSliceMs(20);
    await redis.zadd(WAITING_KEY, Date.now(), "another-task");
    const mock = runWith([{ tool: "Bash", input: { command: "ls" }, durationMs: 300 }, { wait: 2_000 }, { result: "never" }]);
    await runTask(task.id);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.permission.behavior).toBe("allow");
    // the call returned its result (an abort mid-call leaves no output)
    expect(mock.calls[0]!.output).toBeDefined();
    expect(await row(task.id)).toMatchObject({ status: "QUEUED" });
    expect(await stepsNamed(task.id, "workspace_yielded")).toHaveLength(1);
  });

  it("the task's sandbox time ends the run: FAILED with a time_limit incident that goes to a person", async () => {
    // one second left of the task's limit
    const { task } = await workspaceTask({ sandboxSeconds: LIMIT_SEC - 1 });
    runWith([{ llm: { input: 10, output: 10 } }, { wait: 10_000 }, { result: "never" }]);
    const t0 = Date.now();
    await runTask(task.id);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const t = await row(task.id);
    expect(t.status).toBe("FAILED");
    expect(t.error).toMatch(/used up its sandbox time/);
    expect(t.sandboxSeconds).toBeGreaterThanOrEqual(LIMIT_SEC);
    expect(await stepsNamed(task.id, "run_time_limit")).toHaveLength(1);
    const [inc] = await db.select().from(incidents).where(eq(incidents.taskId, task.id));
    expect(inc).toMatchObject({ kind: "time_limit", status: "escalated" });
  });

  it("a task with its time used up does not start a run", async () => {
    const { task } = await workspaceTask({ sandboxSeconds: LIMIT_SEC + 5 });
    const mock = runWith([{ result: "never" }]);
    await runTask(task.id);
    expect(mock.started).toBe(0);
    expect(await row(task.id)).toMatchObject({ status: "FAILED" });
  });

  it("the limit counts from a person's go-ahead (sandboxSecondsBase): the same task runs again", async () => {
    const { task } = await workspaceTask({ sandboxSeconds: LIMIT_SEC + 5, sandboxSecondsBase: LIMIT_SEC + 5 });
    runWith([{ result: "done" }]);
    await runTask(task.id);
    expect(await row(task.id)).toMatchObject({ status: "DONE" });
  });

  it("a task refused a sandbox waits without a failure, and records the wait once", async () => {
    const { task } = await workspaceTask();
    await slot("someone-else");
    const mock = runWith([{ result: "never" }]);
    await runTask(task.id);
    await db.update(tasks).set({ status: "QUEUED" }).where(eq(tasks.id, task.id));
    await runTask(task.id);
    expect(mock.started).toBe(0);
    expect(await row(task.id)).toMatchObject({ status: "QUEUED", sandboxSeconds: 0 });
    const waits = await stepsNamed(task.id, "workspace_slot_busy");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.output).toEqual({ reason: "slots" });
  });
});
