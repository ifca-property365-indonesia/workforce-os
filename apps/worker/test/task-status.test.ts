import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, db, employees, messages, routineRuns, routines, steps, tasks, webhookDeliveries, webhookTriggers } from "@wfos/db";
import type { RunJob } from "@wfos/shared";
import { failTask, handleRunJobFailed, setTaskStatus, settleDispatchedRoutineRuns, settleRoutineRun } from "../src/runner/task-status";
import { afterApprovalResolved } from "../src/runner/approvals";
import {
  LOST_QUEUED_AFTER_MS,
  ORPHAN_AFTER_MS,
  ORPHAN_ERROR,
  probeLiveElsewhere,
  pruneWebhookDeliveries,
  reapOrphanedTasks,
  WEBHOOK_DELIVERY_RETENTION_MS,
} from "../src/scheduler/reaper";
import { isTaskRunActive, registerRun, unregisterRun } from "../src/guards/killswitch";
import { publish, redis, runsQueue } from "../src/lib/redis";
import { CHAT_INTERRUPTED_TEXT, CHAT_TURN_STALE_MS } from "../src/runner/chat-turns";
import { makeApproval, makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const published = (taskId: string) =>
  transport.published.map((p) => p.ev as { type: string; taskId?: string; status?: string }).filter((e) => e.type === "task.updated" && e.taskId === taskId);
const notifies = () => transport.queued.filter((q) => q.queue === "misc" && (q.data as { kind: string }).kind === "notify");
const enqueuedRuns = (taskId: string) => transport.queued.filter((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === taskId);
const backdate = async (id: string, ms = ORPHAN_AFTER_MS + 60_000) => db.update(tasks).set({ updatedAt: new Date(Date.now() - ms) }).where(eq(tasks.id, id));
const nobodyElse = async () => new Set<string>();

async function setup() {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id);
  return { ws, emp };
}

describe("failTask", () => {
  it("fails, publishes and wakes the waiting parent once every subtask has ended", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "DONE" });
    const child = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });

    expect(await failTask(child, "boom")).toBe(true);

    const c = await row(child.id);
    expect(c.status).toBe("FAILED");
    expect(c.error).toBe("boom");
    expect(c.completedAt).toBeInstanceOf(Date);
    expect(published(child.id).map((e) => e.status)).toEqual(["FAILED"]);
    expect((await row(parent.id)).phase).toBe("review");
    expect(enqueuedRuns(parent.id)).toHaveLength(1);
    expect(notifies()).toHaveLength(0); // subtasks never notify humans
  });

  it("does not wake the parent while a sibling is still open", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });
    const child = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });
    await failTask(child, "boom");
    expect((await row(parent.id)).phase).toBe("wait");
    expect(enqueuedRuns(parent.id)).toHaveLength(0);
  });

  it("notifies for a top-level task, not for a replay", async () => {
    const { ws, emp } = await setup();
    const top = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    const replay = await makeTask(ws.id, emp.id, { status: "RUNNING", source: "replay" });
    await failTask(top, "nope", { step: true, stepName: "runner_error", employeeId: emp.id });
    await failTask(replay, "nope");
    expect(notifies()).toHaveLength(1);
    const [s] = await db.select().from(steps).where(and(eq(steps.taskId, top.id), eq(steps.name, "runner_error")));
    expect(s?.kind).toBe("error");
  });

  it("is a no-op on a terminal task and when called twice", async () => {
    const { ws, emp } = await setup();
    const done = await makeTask(ws.id, emp.id, { status: "DONE", result: "ok" });
    expect(await failTask(done, "late")).toBe(false);
    expect((await row(done.id)).status).toBe("DONE");
    expect((await row(done.id)).error).toBeNull();
    expect(published(done.id)).toHaveLength(0);

    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const child = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });
    const [a, b] = await Promise.all([failTask(child, "first"), failTask(child, "second")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(published(child.id)).toHaveLength(1);
    expect(enqueuedRuns(parent.id)).toHaveLength(1); // onChildFinished flipped wait→review once
    expect(await failTask(child, "third")).toBe(false);
    expect(enqueuedRuns(parent.id)).toHaveLength(1);
  });

  it("respects onlyIfStatus and staleBefore", async () => {
    const { ws, emp } = await setup();
    const queued = await makeTask(ws.id, emp.id, { status: "QUEUED" });
    expect(await failTask(queued, "x", { onlyIfStatus: ["RUNNING"] })).toBe(false);
    const fresh = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    expect(await failTask(fresh, "x", { staleBefore: new Date(Date.now() - 60_000) })).toBe(false);
    expect((await row(fresh.id)).status).toBe("RUNNING");
  });

  it("is the failure path of approvals: an approved action that failed fails the task", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const task = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "AWAITING_APPROVAL", result: "drafted" });
    await makeApproval(ws.id, task.id, emp.id, { status: "FAILED", executionResult: { ok: false, summary: "smtp down" } });
    await afterApprovalResolved(task.id);
    const t = await row(task.id);
    expect(t.status).toBe("FAILED");
    expect(t.error).toMatch(/approved actions failed/);
    expect(t.result).toMatch(/Approval outcomes/);
    expect(published(task.id).map((e) => e.status)).toEqual(["FAILED"]);
    expect((await row(parent.id)).phase).toBe("review");
    // resolving again changes nothing
    await afterApprovalResolved(task.id);
    expect(published(task.id)).toHaveLength(1);
  });
});

describe("BullMQ failed handler", () => {
  const job = (taskId: string, attemptsMade: number, failedReason = "boom"): { data: RunJob; attemptsMade: number; opts: { attempts: number }; failedReason: string } => ({
    data: { kind: "task", taskId, workspaceId: "x" },
    attemptsMade,
    opts: { attempts: 3 },
    failedReason,
  });

  it("fails a RUNNING task once retries are exhausted", async () => {
    const { ws, emp } = await setup();
    const t = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    expect(await handleRunJobFailed(job(t.id, 1))).toBe(false);
    expect((await row(t.id)).status).toBe("RUNNING");
    expect(await handleRunJobFailed(job(t.id, 3))).toBe(true);
    const r = await row(t.id);
    expect(r.status).toBe("FAILED");
    expect(r.error).toBe("Worker error: boom");
    expect(published(t.id).map((e) => e.status)).toEqual(["FAILED"]);
    const [s] = await db.select().from(steps).where(and(eq(steps.taskId, t.id), eq(steps.name, "worker_error")));
    expect(s).toBeDefined();
  });

  it("treats a stalled job as final", async () => {
    const { ws, emp } = await setup();
    const t = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    expect(await handleRunJobFailed(job(t.id, 0, "job stalled more than allowable limit"))).toBe(true);
    expect((await row(t.id)).status).toBe("FAILED");
  });

  it("leaves waiting leads, non-running tasks, live runs and chat jobs alone", async () => {
    const { ws, emp } = await setup();
    const lead = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const queued = await makeTask(ws.id, emp.id, { status: "QUEUED" });
    const live = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    registerRun("run-live", { workspaceId: ws.id, taskId: live.id, employeeId: emp.id, controller: new AbortController() });
    try {
      expect(isTaskRunActive(live.id)).toBe(true);
      for (const id of [lead.id, queued.id, live.id]) expect(await handleRunJobFailed(job(id, 3))).toBe(false);
    } finally {
      unregisterRun("run-live");
    }
    expect(await handleRunJobFailed({ data: { kind: "chat", conversationId: lead.id, messageId: "m", workspaceId: ws.id }, attemptsMade: 3, opts: { attempts: 3 } })).toBe(false);
    expect((await row(lead.id)).status).toBe("RUNNING");
    expect((await row(queued.id)).status).toBe("QUEUED");
    expect((await row(live.id)).status).toBe("RUNNING");
  });
});

describe("orphan reaper", () => {
  it("fails an old unattended RUNNING task and records task_reaped", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const orphan = await makeTask(ws.id, emp.id, { status: "RUNNING", parentTaskId: parent.id });
    const review = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "review" });
    await backdate(orphan.id);
    await backdate(review.id);
    await backdate(parent.id);

    const { reaped } = await reapOrphanedTasks({ liveElsewhere: nobodyElse });

    expect(reaped).toEqual(expect.arrayContaining([orphan.id, review.id]));
    expect(reaped).not.toContain(parent.id); // phase wait: the lead has no run of its own
    const o = await row(orphan.id);
    expect(o.status).toBe("FAILED");
    expect(o.error).toBe(ORPHAN_ERROR);
    const [s] = await db.select().from(steps).where(and(eq(steps.taskId, orphan.id), eq(steps.name, "task_reaped")));
    expect(s?.kind).toBe("system");
    expect((await row(parent.id)).phase).toBe("review"); // the reaped subtask woke its lead
    expect((await row(parent.id)).status).toBe("RUNNING");
  });

  it("skips recent tasks, phase hold/wait, other statuses and registered runs", async () => {
    const { ws, emp } = await setup();
    const recent = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    const hold = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "hold" });
    const awaiting = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
    const registered = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    for (const t of [hold, awaiting, registered]) await backdate(t.id);
    registerRun("run-reg", { workspaceId: ws.id, taskId: registered.id, employeeId: emp.id, controller: new AbortController() });
    let reaped: string[];
    try {
      ({ reaped } = await reapOrphanedTasks({ liveElsewhere: nobodyElse }));
    } finally {
      unregisterRun("run-reg");
    }
    for (const t of [recent, hold, awaiting, registered]) expect(reaped).not.toContain(t.id);
    expect((await row(recent.id)).status).toBe("RUNNING");
    expect((await row(hold.id)).status).toBe("RUNNING");
    expect((await row(awaiting.id)).status).toBe("AWAITING_APPROVAL");
    expect((await row(registered.id)).status).toBe("RUNNING");
  });

  it("skips tasks another worker is on, and reaps nothing when the probe fails", async () => {
    const { ws, emp } = await setup();
    const elsewhere = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    const orphan = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    await backdate(elsewhere.id);
    await backdate(orphan.id);

    const failing = await reapOrphanedTasks({
      liveElsewhere: async () => {
        throw new Error("redis down");
      },
    });
    expect(failing.reaped).not.toContain(orphan.id);
    expect((await row(orphan.id)).status).toBe("RUNNING");

    const { reaped } = await reapOrphanedTasks({ liveElsewhere: async () => new Set([elsewhere.id]) });
    expect(reaped).toContain(orphan.id);
    expect(reaped).not.toContain(elsewhere.id);
    expect((await row(elsewhere.id)).status).toBe("RUNNING");
  });

  it("probe: a live employee lease or a pending BullMQ job marks a task as live", async () => {
    const { ws, emp } = await setup();
    const leased = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    const pending = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "review" });
    const orphan = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    const r = redis as unknown as Record<string, unknown>;
    const q = runsQueue as unknown as Record<string, unknown>;
    r.zrangebyscore = async (key: string) => (key === `wfos:emp-lease:${emp.id}` ? [`task-${leased.id}-1700000000000`, "chat-job-1"] : []);
    q.getJobs = async () => [{ data: { kind: "task", taskId: pending.id, workspaceId: ws.id } }, { data: { kind: "chat", conversationId: "c" } }];
    try {
      const live = await probeLiveElsewhere([leased, pending, orphan]);
      expect([...live].sort()).toEqual([leased.id, pending.id].sort());
    } finally {
      delete r.zrangebyscore;
      delete q.getJobs;
    }
  });
});

describe("reaper: QUEUED tasks without a job", () => {
  const lost = (id: string) => backdate(id, LOST_QUEUED_AFTER_MS + 60_000);

  it("re-enqueues an old QUEUED task that has no job and records task_requeued", async () => {
    const { ws, emp } = await setup();
    const t = await makeTask(ws.id, emp.id);
    await lost(t.id);
    const { requeued } = await reapOrphanedTasks({ liveElsewhere: nobodyElse });
    expect(requeued).toContain(t.id);
    expect(enqueuedRuns(t.id)).toHaveLength(1);
    expect((await row(t.id)).status).toBe("QUEUED");
    const [s] = await db.select().from(steps).where(and(eq(steps.taskId, t.id), eq(steps.name, "task_requeued")));
    expect(s?.kind).toBe("system");
  });

  it("leaves recent, held, live, killed, quota-paused and inactive-executor tasks alone", async () => {
    const { ws, emp } = await setup();
    const recent = await makeTask(ws.id, emp.id);
    const hold = await makeTask(ws.id, emp.id, { phase: "hold" });
    const live = await makeTask(ws.id, emp.id);
    const killedWs = await makeWorkspace({ killSwitch: true });
    const killedEmp = await makeEmployee(killedWs.id);
    const killed = await makeTask(killedWs.id, killedEmp.id);
    const quotaWs = await makeWorkspace({ quotaPausedUntil: new Date(Date.now() + 3_600_000), quotaPauseReason: "limit" });
    const quotaEmp = await makeEmployee(quotaWs.id);
    const quota = await makeTask(quotaWs.id, quotaEmp.id);
    const paused = await makeEmployee(ws.id);
    await db.update(employees).set({ status: "PAUSED_BUDGET" }).where(eq(employees.id, paused.id));
    const inactive = await makeTask(ws.id, paused.id);
    for (const t of [hold, live, killed, quota, inactive]) await lost(t.id);

    const { requeued } = await reapOrphanedTasks({ liveElsewhere: async () => new Set([live.id]) });
    for (const t of [recent, hold, live, killed, quota, inactive]) {
      expect(requeued).not.toContain(t.id);
      expect(enqueuedRuns(t.id)).toHaveLength(0);
    }
  });

  it("enqueues nothing when the job probe fails", async () => {
    const { ws, emp } = await setup();
    const t = await makeTask(ws.id, emp.id);
    await lost(t.id);
    const { requeued } = await reapOrphanedTasks({
      liveElsewhere: async () => {
        throw new Error("redis down");
      },
    });
    expect(requeued).toEqual([]);
    expect(enqueuedRuns(t.id)).toHaveLength(0);
  });
});

describe("reaper: webhook deliveries", () => {
  it("deletes deliveries older than 30 days in batches and keeps the rest", async () => {
    const ws = await makeWorkspace();
    const [trigger] = await db.insert(webhookTriggers).values({ workspaceId: ws.id, name: "Inbound", secretHash: "x".repeat(64) }).returning();
    const old = new Date(Date.now() - WEBHOOK_DELIVERY_RETENTION_MS - 3_600_000);
    await db.insert(webhookDeliveries).values([
      ...Array.from({ length: 1205 }, () => ({ triggerId: trigger!.id, workspaceId: ws.id, status: "accepted" as const, receivedAt: old })),
      { triggerId: trigger!.id, workspaceId: ws.id, status: "accepted" as const, receivedAt: new Date(Date.now() - WEBHOOK_DELIVERY_RETENTION_MS + 3_600_000) },
      { triggerId: trigger!.id, workspaceId: ws.id, status: "rejected" as const },
    ]);
    expect(await pruneWebhookDeliveries()).toBe(1205);
    const left = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.triggerId, trigger!.id));
    expect(left).toHaveLength(2);
    expect((await reapOrphanedTasks({ liveElsewhere: nobodyElse })).webhookDeliveriesPruned).toBe(0);
  });
});

describe("routine runs", () => {
  async function routineRun(n: number) {
    const { ws, emp } = await setup();
    const [r] = await db.insert(routines).values({ workspaceId: ws.id, name: "Weekly", cron: "0 9 * * 1", brief: "Report" }).returning();
    const ts = [];
    for (let i = 0; i < n; i++) ts.push(await makeTask(ws.id, emp.id, { status: "RUNNING", routineId: r!.id, source: "routine", title: `T${i}` }));
    const [run] = await db.insert(routineRuns).values({ routineId: r!.id, taskIds: ts.map((t) => t.id), status: "dispatched" }).returning();
    const get = async () => (await db.select().from(routineRuns).where(eq(routineRuns.id, run!.id)))[0]!;
    return { ws, emp, ts, get };
  }

  it("settles to done once every task is DONE", async () => {
    const { ts, get } = await routineRun(2);
    await setTaskStatus(ts[0]!, "DONE", { result: "a" });
    expect((await get()).status).toBe("dispatched");
    await setTaskStatus(ts[1]!, "DONE", { result: "b" });
    const run = await get();
    expect(run.status).toBe("done");
    expect(run.error).toBeNull();
    expect(await settleRoutineRun(ts[1]!)).toEqual([]); // idempotent
  });

  it("settles to failed with the first failure once every task has ended", async () => {
    const { ts, get } = await routineRun(3);
    await failTask(ts[1]!, "second broke");
    await setTaskStatus(ts[0]!, "DONE", { result: "a" });
    expect((await get()).status).toBe("dispatched");
    await failTask(ts[2]!, "third broke");
    const run = await get();
    expect(run.status).toBe("failed");
    expect(run.error).toBe("second broke");
  });

  it("the sweep settles runs whose tasks ended elsewhere (cancelled from the API) and empty firings", async () => {
    const { ts, get } = await routineRun(1);
    await db.update(tasks).set({ status: "CANCELLED" }).where(eq(tasks.id, ts[0]!.id));
    const [r] = await db.select({ id: routines.id }).from(routines).where(eq(routines.id, ts[0]!.routineId!));
    const [empty] = await db.insert(routineRuns).values({ routineId: r!.id, taskIds: [], status: "dispatched" }).returning();
    expect(await settleDispatchedRoutineRuns()).toBeGreaterThanOrEqual(2);
    const run = await get();
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/ended CANCELLED/);
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, empty!.id)))[0]!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Review fixes: ordered, best-effort terminal side effects; conditional setTaskStatus; reaper sweeps.
// ---------------------------------------------------------------------------

/** Make the mocked publish fail (all calls, or only those matching `when`) for the duration of `fn`. */
async function withFailingPublish<T>(fn: () => Promise<T>, when: (ev: { type: string; status?: string }) => boolean = () => true): Promise<T> {
  const pub = vi.mocked(publish);
  const orig = pub.getMockImplementation()!;
  pub.mockImplementation(async (workspaceId: string, ev: unknown) => {
    if (when(ev as { type: string })) throw new Error("redis down");
    return orig(workspaceId, ev as never);
  });
  try {
    return await fn();
  } finally {
    pub.mockImplementation(orig);
  }
}

async function routineWithRun(ws: { id: string }) {
  const [r] = await db.insert(routines).values({ workspaceId: ws.id, name: "Daily", cron: "0 9 * * *", brief: "Report" }).returning();
  return r!;
}

describe("afterTerminal (setTaskStatus DONE / CANCELLED, approvals close, failTask)", () => {
  it("wakes the parent before publishing, and a failing publish skips nothing", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const r = await routineWithRun(ws);
    const child = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING", routineId: r.id, source: "routine" });
    const [run] = await db.insert(routineRuns).values({ routineId: r.id, taskIds: [child.id], status: "dispatched" }).returning();

    let parentPhaseAtPublish: string | null | undefined;
    const pub = vi.mocked(publish);
    const orig = pub.getMockImplementation()!;
    pub.mockImplementation(async (workspaceId: string, ev: unknown) => {
      const e = ev as { type: string; taskId?: string };
      if (e.type === "task.updated" && e.taskId === child.id) {
        parentPhaseAtPublish = (await row(parent.id)).phase;
        throw new Error("redis down");
      }
      return orig(workspaceId, ev as never);
    });
    try {
      expect(await setTaskStatus(child, "DONE", { result: "ok" })).toBe(true);
    } finally {
      pub.mockImplementation(orig);
    }

    expect(parentPhaseAtPublish).toBe("review"); // onChildFinished ran first
    expect(enqueuedRuns(parent.id)).toHaveLength(1);
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, run!.id)))[0]!.status).toBe("done");
  });

  it("a failing publish still notifies (DONE), and a cancellation wakes the parent without notifying", async () => {
    const { ws, emp } = await setup();
    const top = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    await withFailingPublish(() => setTaskStatus(top, "DONE", { result: "final answer" }));
    expect((await row(top.id)).status).toBe("DONE");
    expect(notifies()).toHaveLength(1);
    expect((notifies()[0]!.data as { text: string }).text).toBe("final answer");

    resetTransport();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const child = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });
    const lone = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    await setTaskStatus(child, "CANCELLED", { error: "Cancelled" });
    await setTaskStatus(lone, "CANCELLED", { error: "Cancelled" });
    expect((await row(parent.id)).phase).toBe("review");
    expect(published(lone.id).map((e) => e.status)).toEqual(["CANCELLED"]);
    expect(notifies()).toHaveLength(0);
  });

  it("failTask: a failing publish does not skip waking the parent or notifying", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const child = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });
    const top = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    await withFailingPublish(async () => {
      expect(await failTask(child, "boom")).toBe(true);
      expect(await failTask(top, "boom")).toBe(true);
    });
    expect((await row(parent.id)).phase).toBe("review");
    expect(notifies()).toHaveLength(1);
  });

  it("approvals: the DONE close wakes the parent, settles and notifies even when publishing fails", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const task = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "AWAITING_APPROVAL", result: "drafted" });
    await makeApproval(ws.id, task.id, emp.id, { status: "EXECUTED", executionResult: { ok: true, summary: "sent" } });
    const top = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL", result: "drafted" });
    await makeApproval(ws.id, top.id, emp.id, { status: "EXECUTED", executionResult: { ok: true, summary: "sent" } });

    await withFailingPublish(async () => {
      await afterApprovalResolved(task.id);
      await afterApprovalResolved(top.id);
    });

    expect((await row(task.id)).status).toBe("DONE");
    expect((await row(parent.id)).phase).toBe("review");
    expect(notifies()).toHaveLength(1); // the top-level one only
    expect((notifies()[0]!.data as { text: string }).text).toMatch(/Approval outcomes/);
  });
});

describe("setTaskStatus is conditional", () => {
  it("does nothing (no write, no side effects) when the row's status moved on", async () => {
    const { ws, emp } = await setup();
    const parent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    const t = await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" });
    await db.update(tasks).set({ status: "CANCELLED", error: "Cancelled by user" }).where(eq(tasks.id, t.id)); // the web API
    await makeTask(ws.id, emp.id, { parentTaskId: parent.id, status: "RUNNING" }); // keeps the parent waiting

    expect(await setTaskStatus(t, "DONE", { result: "late" })).toBe(false);
    const r = await row(t.id);
    expect(r.status).toBe("CANCELLED");
    expect(r.result).toBeNull();
    expect(published(t.id)).toHaveLength(0);
    expect(notifies()).toHaveLength(0);

    const q = await makeTask(ws.id, emp.id, { status: "QUEUED" });
    expect(await setTaskStatus(q, "RUNNING")).toBe(true);
    expect(await setTaskStatus(q, "RUNNING")).toBe(false); // a second job with the stale QUEUED row
  });
});

describe("settleRoutineRun", () => {
  it("looks the routine up when the caller passes only the task id", async () => {
    const { ws, emp } = await setup();
    const r = await routineWithRun(ws);
    const t = await makeTask(ws.id, emp.id, { status: "DONE", routineId: r.id, source: "routine" });
    const [run] = await db.insert(routineRuns).values({ routineId: r.id, taskIds: [t.id], status: "dispatched" }).returning();
    expect(await settleRoutineRun({ id: t.id })).toEqual([{ id: run!.id, status: "done" }]);
    const plain = await makeTask(ws.id, emp.id, { status: "DONE" });
    expect(await settleRoutineRun({ id: plain.id })).toEqual([]);
  });
});

describe("chat turns of failed jobs", () => {
  async function streamingTurn(content = "") {
    const { ws, emp } = await setup();
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: emp.id }).returning();
    const [u] = await db.insert(messages).values({ conversationId: conv!.id, role: "user", content: "hi", handledAt: new Date() }).returning();
    const [a] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, role: "assistant", content, employeeId: emp.id, status: "streaming", meta: { turnMessageIds: [u!.id] } })
      .returning();
    return { ws, emp, conv: conv!, user: u!, assistant: a! };
  }
  const chatJob = (workspaceId: string, conversationId: string, messageId: string, attemptsMade = 1, failedReason = "boom") => ({
    data: { kind: "chat" as const, conversationId, messageId, workspaceId },
    attemptsMade,
    opts: { attempts: 1 },
    failedReason,
  });
  const msgRow = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
  const chatPublished = (id: string) =>
    transport.published.map((p) => p.ev as { type: string; message?: { id: string; status: string } }).filter((e) => e.type === "chat.message" && e.message?.id === id);

  it("a final failure flips the turn's streaming reply to error and publishes it", async () => {
    const { ws, conv, user, assistant } = await streamingTurn();
    expect(await handleRunJobFailed({ ...chatJob(ws.id, conv.id, user.id, 0), opts: { attempts: 3 } })).toBe(false); // retries left
    expect((await msgRow(assistant.id)).status).toBe("streaming");

    expect(await handleRunJobFailed(chatJob(ws.id, conv.id, user.id))).toBe(true);
    const m = await msgRow(assistant.id);
    expect(m.status).toBe("error");
    expect(m.content).toBe(CHAT_INTERRUPTED_TEXT);
    expect(chatPublished(assistant.id).map((e) => e.message!.status)).toEqual(["error"]);
    expect(await handleRunJobFailed(chatJob(ws.id, conv.id, user.id))).toBe(false); // already closed
  });

  it("a stalled chat job closes the turn too, keeping text already written", async () => {
    const { ws, conv, user, assistant } = await streamingTurn("Partial answ");
    expect(await handleRunJobFailed(chatJob(ws.id, conv.id, user.id, 0, "job stalled more than allowable limit"))).toBe(true);
    expect((await msgRow(assistant.id)).content).toBe("Partial answ");
  });

  it("the reaper closes streaming replies older than 15 minutes, not fresh ones or live conversations", async () => {
    const old = await streamingTurn();
    const fresh = await streamingTurn();
    const live = await streamingTurn();
    const past = new Date(Date.now() - CHAT_TURN_STALE_MS - 60_000);
    for (const t of [old, live]) await db.update(messages).set({ createdAt: past }).where(eq(messages.id, t.assistant.id));
    registerRun("run-chat", { workspaceId: live.ws.id, taskId: null, conversationId: live.conv.id, employeeId: live.emp.id, controller: new AbortController() });
    let closed: string[];
    try {
      ({ chatTurnsClosed: closed } = await reapOrphanedTasks({ liveElsewhere: nobodyElse }));
    } finally {
      unregisterRun("run-chat");
    }
    expect(closed).toContain(old.assistant.id);
    expect(closed).not.toContain(fresh.assistant.id);
    expect(closed).not.toContain(live.assistant.id);
    expect((await msgRow(old.assistant.id)).status).toBe("error");
    expect((await msgRow(old.assistant.id)).content).toBe(CHAT_INTERRUPTED_TEXT);
    expect(chatPublished(old.assistant.id)).toHaveLength(1);
    expect((await msgRow(fresh.assistant.id)).status).toBe("streaming");
    expect((await msgRow(live.assistant.id)).status).toBe("streaming");
  });
});

describe("reaper: stuck leads and resolved approvals", () => {
  it("wakes a waiting lead whose subtasks were all cancelled from the web API", async () => {
    const { ws, emp } = await setup();
    const lead = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    await makeTask(ws.id, emp.id, { parentTaskId: lead.id, status: "CANCELLED" });
    await makeTask(ws.id, emp.id, { parentTaskId: lead.id, status: "DONE" });
    const busy = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    await makeTask(ws.id, emp.id, { parentTaskId: busy.id, status: "RUNNING" });
    const recent = await makeTask(ws.id, emp.id, { status: "RUNNING", phase: "wait" });
    await makeTask(ws.id, emp.id, { parentTaskId: recent.id, status: "CANCELLED" });
    await backdate(lead.id);
    await backdate(busy.id);

    const { leadsChecked, reaped } = await reapOrphanedTasks({ liveElsewhere: nobodyElse });

    expect(leadsChecked).toEqual(expect.arrayContaining([lead.id, busy.id]));
    expect(leadsChecked).not.toContain(recent.id);
    expect(reaped).not.toContain(lead.id);
    expect((await row(lead.id)).phase).toBe("review");
    expect((await row(lead.id)).status).toBe("RUNNING");
    expect(enqueuedRuns(lead.id)).toHaveLength(1);
    expect((await row(busy.id)).phase).toBe("wait");
    expect(enqueuedRuns(busy.id)).toHaveLength(0);
    expect((await row(recent.id)).phase).toBe("wait");
  });

  it("resumes AWAITING_APPROVAL tasks whose approvals were all resolved, and only those", async () => {
    const { ws, emp } = await setup();
    const longAgo = new Date(Date.now() - ORPHAN_AFTER_MS - 60_000);
    const stuck = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL", result: "drafted" });
    await makeApproval(ws.id, stuck.id, emp.id, { status: "EXECUTED", decidedAt: longAgo, executionResult: { ok: true, summary: "sent" } });
    const pending = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
    await makeApproval(ws.id, pending.id, emp.id, { status: "EXECUTED", decidedAt: longAgo });
    await makeApproval(ws.id, pending.id, emp.id, { status: "PENDING" });
    const justDecided = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
    await makeApproval(ws.id, justDecided.id, emp.id, { status: "REJECTED", decidedAt: new Date() });
    const none = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
    for (const t of [stuck, pending, justDecided, none]) await backdate(t.id);

    const { approvalsResumed } = await reapOrphanedTasks({ liveElsewhere: nobodyElse });

    expect(approvalsResumed).toContain(stuck.id);
    for (const t of [pending, justDecided, none]) expect(approvalsResumed).not.toContain(t.id);
    expect((await row(stuck.id)).status).toBe("DONE");
    expect(published(stuck.id).map((e) => e.status)).toEqual(["DONE"]);
    expect(notifies()).toHaveLength(1);
    for (const t of [pending, justDecided, none]) expect((await row(t.id)).status).toBe("AWAITING_APPROVAL");

    // a second sweep is a no-op
    const again = await reapOrphanedTasks({ liveElsewhere: nobodyElse });
    expect(again.approvalsResumed).not.toContain(stuck.id);
    expect(published(stuck.id)).toHaveLength(1);
  });
});
