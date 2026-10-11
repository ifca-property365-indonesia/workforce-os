import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, db, routineRuns, routines, tasks, teams, users } from "@wfos/db";
import { ROUTINE_CATCH_UP_MS } from "@wfos/shared";
import { previousRunOpen, tickRoutines } from "../src/scheduler/routines";
import { settleRoutineRun } from "../src/runner/task-status";
import { executeApproval } from "../src/runner/approvals";
import { executeAction } from "../src/tools/actions";
import { buildTools } from "../src/tools/registry";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport } from "./transport";

beforeEach(() => resetTransport());

const HOUR = 3_600_000;

async function routineDue(over: Partial<typeof routines.$inferInsert> = {}, lateMs = 60_000) {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id);
  const now = new Date();
  const [r] = await db
    .insert(routines)
    .values({ workspaceId: ws.id, name: "Daily", cron: "0 9 * * *", timezone: "Asia/Jakarta", brief: "Report", assigneeId: emp.id, nextRunAt: new Date(now.getTime() - lateMs), ...over })
    .returning();
  return { ws, emp, r: r!, now };
}

const runsOf = (routineId: string) => db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
const tasksOf = (routineId: string) => db.select().from(tasks).where(eq(tasks.routineId, routineId));

describe("routine tick: catch-up window", () => {
  it("a firing more than ROUTINE_CATCH_UP_MS late is recorded as missed, not run, and next_run_at moves on", async () => {
    const { r, now } = await routineDue({}, ROUTINE_CATCH_UP_MS + HOUR);
    await tickRoutines(now);
    const runs = await runsOf(r.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "missed", trigger: "schedule", taskIds: [] });
    expect(runs[0]!.error).toMatch(/late/);
    expect(await tasksOf(r.id)).toHaveLength(0);
    const [after] = await db.select().from(routines).where(eq(routines.id, r.id));
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(after!.lastRunAt).toBeNull();
    // a second tick does nothing more (not due any longer)
    await tickRoutines(now);
    expect(await runsOf(r.id)).toHaveLength(1);
  });

  it("a firing within the window runs once", async () => {
    const { r, now } = await routineDue({}, ROUTINE_CATCH_UP_MS - HOUR);
    await tickRoutines(now);
    const runs = await runsOf(r.id);
    expect(runs.map((x) => x.status)).toEqual(["dispatched"]);
    expect(await tasksOf(r.id)).toHaveLength(1);
  });
});

describe("routine tick: overlap", () => {
  async function withOpenPreviousRun(overlap: "skip" | "queue") {
    const ctx = await routineDue({ overlap });
    const prev = await makeTask(ctx.ws.id, ctx.emp.id, { status: "RUNNING", routineId: ctx.r.id, source: "routine" });
    await db.insert(routineRuns).values({ routineId: ctx.r.id, taskIds: [prev.id], status: "dispatched", startedAt: new Date(ctx.now.getTime() - 86_400_000) });
    return { ...ctx, prev };
  }

  it("skip: the previous firing still has an open task → skipped_overlap, nothing dispatched", async () => {
    const { r, now, prev } = await withOpenPreviousRun("skip");
    expect(await previousRunOpen(r.id)).toBe(true);
    await tickRoutines(now);
    const runs = await runsOf(r.id);
    expect(runs.map((x) => x.status).sort()).toEqual(["dispatched", "skipped_overlap"]);
    expect((await tasksOf(r.id)).map((t) => t.id)).toEqual([prev.id]);
    const [after] = await db.select().from(routines).where(eq(routines.id, r.id));
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("queue: dispatches anyway", async () => {
    const { r, now } = await withOpenPreviousRun("queue");
    await tickRoutines(now);
    expect((await runsOf(r.id)).filter((x) => x.status === "dispatched")).toHaveLength(2);
    expect(await tasksOf(r.id)).toHaveLength(2);
  });

  it("skip: a previous firing whose tasks all ended does not block", async () => {
    const { r, now, prev } = await withOpenPreviousRun("skip");
    await db.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, prev.id));
    expect(await previousRunOpen(r.id)).toBe(false);
    await tickRoutines(now);
    expect(await tasksOf(r.id)).toHaveLength(2);
  });

  it("settleRoutineRun leaves missed and skipped rows alone", async () => {
    const { ws, emp, r } = await routineDue();
    const t = await makeTask(ws.id, emp.id, { status: "DONE", routineId: r.id, source: "routine" });
    const [missed] = await db.insert(routineRuns).values({ routineId: r.id, taskIds: [t.id], status: "missed" }).returning();
    const [skipped] = await db.insert(routineRuns).values({ routineId: r.id, taskIds: [t.id], status: "skipped_overlap" }).returning();
    expect(await settleRoutineRun({ id: t.id, routineId: r.id })).toEqual([]);
    const rows = await runsOf(r.id);
    expect(rows.find((x) => x.id === missed!.id)!.status).toBe("missed");
    expect(rows.find((x) => x.id === skipped!.id)!.status).toBe("skipped_overlap");
  });
});

describe("propose_routine", () => {
  const proposer = { toolPermissions: [{ tool: "propose_routine", enabled: true }] };
  const tool = (ctx: ReturnType<typeof runContext>) => buildTools(ctx).find((d) => d.name === "propose_routine")!;
  const text = (r: { content: unknown[] }) => r.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
  const input = { name: "Weekly status", cron: "0 9 * * 1", timezone: "Asia/Jakarta", brief: "Write the weekly status for every active project." };

  it("creates a create_routine approval with the parsed fields and the next 3 runs; nothing is created yet", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, proposer);
    const task = await makeTask(ws.id, emp.id);
    const ctx = runContext(ws, emp, task.id);
    const res = await tool(ctx).handler(input, {});
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/NOT been created/);
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(a).toMatchObject({ toolName: "create_routine", status: "PENDING", employeeId: emp.id });
    expect(a!.title).toBe("New routine: Weekly status");
    const p = a!.payload as Record<string, unknown>;
    expect(p).toMatchObject({ ...input, assigneeId: emp.id, teamId: null, overlap: "skip", targetName: emp.name, untrustedInput: false });
    const next = p.nextRuns as string[];
    expect(next).toHaveLength(3);
    // Mondays 09:00 Jakarta = 02:00 UTC, one week apart
    for (const d of next) expect(new Date(d).toISOString()).toMatch(/T02:00:00\.000Z$/);
    expect(new Date(next[1]!).getTime() - new Date(next[0]!).getTime()).toBe(7 * 86_400_000);
    expect(ctx.pendingApprovalIds).toEqual([a!.id]);
    expect(await db.select().from(routines).where(eq(routines.workspaceId, ws.id))).toHaveLength(0);
  });

  it("refuses an invalid cron, an unknown time zone, and an assignee or team of another workspace", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, proposer);
    const other = await makeWorkspace();
    const stranger = await makeEmployee(other.id);
    const [foreignTeam] = await db.insert(teams).values({ workspaceId: other.id, name: "Elsewhere" }).returning();
    const ctx = runContext(ws, emp, null);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...input, cron: "61 9 * * 1" }, /Invalid cron/],
      [{ ...input, cron: "every monday" }, /exactly 5 fields/],
      // six fields (seconds first) parse as cron, but the platform's rule is exactly five
      [{ ...input, cron: "0 0 9 * * 1" }, /exactly 5 fields/],
      [{ ...input, timezone: "Mars/Olympus" }, /time zone/],
      [{ ...input, assigneeId: stranger.id }, /not an employee of this workspace/],
      [{ ...input, teamId: foreignTeam!.id }, /not part of this workspace/],
      [{ ...input, assigneeId: emp.id, teamId: foreignTeam!.id }, /not both/],
    ];
    for (const [args, re] of cases) {
      const res = await tool(ctx).handler(args, {});
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(text(res)).toMatch(re);
    }
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(0);
  });

  it("is not available without the grant", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [] });
    expect(buildTools(runContext(ws, emp, null)).some((d) => d.name === "propose_routine")).toBe(false);
  });

  it("approving it creates the routine enabled with next_run_at and audits the approver", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, proposer);
    const [u] = await db.insert(users).values({ email: `owner-${randomUUID().slice(0, 8)}@test.local`, name: "Owner", passwordHash: "x" }).returning();
    const ctx = runContext(ws, emp, null);
    await tool(ctx).handler({ ...input, overlap: "queue" }, {});
    const [a] = await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id));
    await db.update(approvals).set({ status: "APPROVED", decidedBy: u!.id, decidedAt: new Date() }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    const [done] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(done!.status).toBe("EXECUTED");
    const [r] = await db.select().from(routines).where(eq(routines.workspaceId, ws.id));
    expect(r).toMatchObject({ name: "Weekly status", cron: "0 9 * * 1", timezone: "Asia/Jakarta", assigneeId: emp.id, teamId: null, overlap: "queue", enabled: true });
    expect(r!.nextRunAt!.getTime()).toBe(new Date((a!.payload as { nextRuns: string[] }).nextRuns[0]!).getTime());
    expect((done!.executionResult as { summary: string }).summary).toMatch(/^Routine Weekly status created — next run \d{4}-\d{2}-\d{2} 09:00 \(Asia\/Jakarta\)$/);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "routine.created")));
    expect(entry).toMatchObject({ actorUserId: u!.id, actorLabel: u!.email, targetId: r!.id });
  });

  it("execution re-validates the (edited) payload: invalid cron or a foreign assignee is refused", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const other = await makeWorkspace();
    const stranger = await makeEmployee(other.id);
    const base = { ...input, assigneeId: emp.id, teamId: null, overlap: "skip" };
    const bad = await executeAction(ws.id, "create_routine", { ...base, cron: "99 * * * *" }, { employeeId: emp.id });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.summary).toMatch(/Invalid cron/);
    const foreign = await executeAction(ws.id, "create_routine", { ...base, assigneeId: stranger.id }, { employeeId: emp.id });
    expect(foreign).toMatchObject({ ok: false });
    expect(foreign.summary).toMatch(/not an employee of this workspace/);
    const six = await executeAction(ws.id, "create_routine", { ...base, cron: "0 0 9 * * 1" }, { employeeId: emp.id });
    expect(six.ok).toBe(false);
    expect(six.summary).toMatch(/exactly 5 fields/);
    const tz = await executeAction(ws.id, "create_routine", { ...base, timezone: "Nowhere/Land" }, { employeeId: emp.id });
    expect(tz.ok).toBe(false);
    expect(await db.select().from(routines).where(eq(routines.workspaceId, ws.id))).toHaveLength(0);
  });

  it("a routine proposed by a tainted run is created untrustedInput, and every task it fires starts tainted", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, proposer);
    const [u] = await db.insert(users).values({ email: `owner-${randomUUID().slice(0, 8)}@test.local`, name: "Owner", passwordHash: "x" }).returning();
    const ctx = runContext(ws, emp, null);
    ctx.guard.tainted = true; // the run read injected content before proposing
    await tool(ctx).handler(input, {});
    const [a] = await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id));
    expect((a!.payload as Record<string, unknown>).untrustedInput).toBe(true);
    // the human may even edit the payload: the mark is read from the run's own payload
    await db.update(approvals).set({ status: "APPROVED", decidedBy: u!.id, decidedAt: new Date(), editedPayload: { ...(a!.payload as object), untrustedInput: false } }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    const [r] = await db.select().from(routines).where(eq(routines.workspaceId, ws.id));
    expect(r).toMatchObject({ name: "Weekly status", untrustedInput: true, enabled: true });

    await db.update(routines).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(routines.id, r!.id));
    await tickRoutines(new Date());
    const fired = await tasksOf(r!.id);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.untrustedInput).toBe(true);
  });

  it("a routine from a clean run (or created by a person) fires trusted tasks", async () => {
    const { r, now } = await routineDue();
    expect(r.untrustedInput).toBe(false);
    await tickRoutines(now);
    const fired = await tasksOf(r.id);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.untrustedInput).toBe(false);
    const created = await executeAction(r.workspaceId, "create_routine", { ...input, assigneeId: r.assigneeId, teamId: null }, { employeeId: r.assigneeId, untrusted: false });
    expect(created.ok).toBe(true);
    const all = await db.select().from(routines).where(eq(routines.workspaceId, r.workspaceId));
    expect(all.every((x) => x.untrustedInput === false)).toBe(true);
  });
});
