import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, db, employees, tasks, workflowRuns, workflows, workspaces } from "@wfos/db";
import type { WorkflowStep, WorkflowTrigger } from "@wfos/shared";
import { advanceStuckWorkflowRuns, advanceWorkflowRun, startWorkflowRun, tickWorkflows } from "../src/runner/workflows";
import { executeApproval, expireUnansweredApprovals, handleRejection } from "../src/runner/approvals";
import { failTask, setTaskStatus } from "../src/runner/task-status";
import { buildTools } from "../src/tools/registry";
import { makeEmployee, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

async function workflow(steps: (emp: string) => WorkflowStep[], trigger: WorkflowTrigger = { kind: "manual" }, over: Partial<typeof workflows.$inferInsert> = {}) {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id);
  const [wf] = await db.insert(workflows).values({ workspaceId: ws.id, name: "Laporan mingguan", trigger, steps: steps(emp.id), enabled: true, ...over }).returning();
  return { ws, emp, wf: wf! };
}

const runOf = async (id: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]!;
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

/** the employee finishes the run's current task with `result` (the hook moves the run on) */
async function finish(runId: string, result: string, status: "DONE" | "FAILED" = "DONE") {
  const r = await runOf(runId);
  const t = await taskOf(r.waitingTaskId!);
  await db.update(tasks).set({ status: "RUNNING" }).where(eq(tasks.id, t.id));
  if (status === "DONE") await setTaskStatus({ ...t, status: "RUNNING" }, "DONE", { result });
  else await failTask(t, "boom");
  await advanceWorkflowRun(runId); // the advance job the hook enqueued
}

describe("workflow runs", () => {
  it("agent → condition → notify: tasks in order, the previous output handed on as data, done at the end", async () => {
    const { ws, emp, wf } = await workflow((e) => [
      { kind: "agent", employeeId: e, instruction: "Kumpulkan angka penjualan minggu ini." },
      { kind: "condition", mode: "contains", text: "naik" },
      { kind: "agent", employeeId: e, instruction: "Tulis ringkasan untuk direksi." },
      { kind: "notify", title: "Ringkasan siap" },
    ]);
    const run = (await startWorkflowRun(wf.id, "manual"))!;
    let r = await runOf(run.id);
    expect(r).toMatchObject({ status: "waiting", stepIndex: 0 });
    const first = await taskOf(r.waitingTaskId!);
    expect(first).toMatchObject({ assigneeId: emp.id, source: "workflow", workflowRunId: run.id, title: "Laporan mingguan · 1", status: "QUEUED" });
    expect(transport.queued.some((j) => (j.data as { taskId?: string }).taskId === first.id)).toBe(true);

    await finish(run.id, "Penjualan naik 12%");
    r = await runOf(run.id);
    expect(r).toMatchObject({ status: "waiting", stepIndex: 2, outputs: ["Penjualan naik 12%", "Penjualan naik 12%"] });
    const second = await taskOf(r.waitingTaskId!);
    expect(second.brief).toContain("Tulis ringkasan untuk direksi.");
    expect(second.brief).toContain("<previous_step_output>\nPenjualan naik 12%\n</previous_step_output>");

    await finish(run.id, "Ringkasan: penjualan naik.");
    r = await runOf(run.id);
    expect(r).toMatchObject({ status: "done", stepIndex: 4, waitingTaskId: null });
    expect(r.finishedAt).toBeInstanceOf(Date);
    const n = transport.queued.find((j) => j.name === "notify" && (j.data as { subject: string }).subject.startsWith("Laporan mingguan:"))!.data as { subject: string; text: string };
    expect(n).toMatchObject({ subject: "Laporan mingguan: Ringkasan siap", text: "Ringkasan: penjualan naik." });
    expect((await db.select().from(workflows).where(eq(workflows.workspaceId, ws.id)))[0]!.lastRunAt).toBeInstanceOf(Date);
  });

  it("a condition that does not hold stops the run; a failed task fails it with a notice", async () => {
    const a = await workflow((e) => [
      { kind: "agent", employeeId: e, instruction: "Cek stok." },
      { kind: "condition", mode: "not_contains", text: "aman" },
      { kind: "notify", title: "Stok menipis" },
    ]);
    const r1 = (await startWorkflowRun(a.wf.id, "manual"))!;
    await finish(r1.id, "Stok AMAN semua");
    expect(await runOf(r1.id)).toMatchObject({ status: "stopped", error: 'Step 2: the previous output contains "aman".' });
    expect(transport.queued.some((j) => j.name === "notify" && (j.data as { subject: string }).subject.includes("Stok menipis"))).toBe(false);

    const b = await workflow((e) => [{ kind: "agent", employeeId: e, instruction: "x" }]);
    const r2 = (await startWorkflowRun(b.wf.id, "manual"))!;
    await finish(r2.id, "", "FAILED");
    expect(await runOf(r2.id)).toMatchObject({ status: "failed" });
    expect((await runOf(r2.id)).error).toMatch(/^Step 1: the task ended failed/);
    expect(transport.queued.some((j) => j.name === "notify" && (j.data as { notificationKind?: string }).notificationKind === "routine_failed")).toBe(true);
  });

  it("an approval step waits for a person: approve goes on, reject or no answer stops", async () => {
    const steps = (e: string): WorkflowStep[] => [
      { kind: "approval", title: "Kirim ke klien?" },
      { kind: "agent", employeeId: e, instruction: "Kirim." },
    ];
    const a = await workflow(steps);
    const r1 = (await startWorkflowRun(a.wf.id, "manual"))!;
    let r = await runOf(r1.id);
    expect(r.status).toBe("waiting");
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, r.waitingApprovalId!));
    expect(ap).toMatchObject({ toolName: "workflow_step", status: "PENDING", title: "Laporan mingguan: Kirim ke klien?", taskId: null });
    expect(transport.queued.some((j) => j.name === "notify" && (j.data as { approvalId?: string }).approvalId === ap!.id)).toBe(true);
    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, ap!.id));
    await executeApproval(ap!.id);
    await advanceWorkflowRun(r1.id);
    r = await runOf(r1.id);
    expect(r).toMatchObject({ status: "waiting", stepIndex: 1 });
    expect(r.waitingTaskId).not.toBeNull();

    const b = await workflow(steps);
    const r2 = (await startWorkflowRun(b.wf.id, "manual"))!;
    const apB = (await runOf(r2.id)).waitingApprovalId!;
    await db.update(approvals).set({ status: "REJECTED" }).where(eq(approvals.id, apB));
    await handleRejection(apB);
    await advanceWorkflowRun(r2.id);
    expect(await runOf(r2.id)).toMatchObject({ status: "stopped", error: 'Step 1: "Kirim ke klien?" was rejected.' });

    const c = await workflow(steps);
    await db.update(workspaces).set({ approvalExpiryHours: 1 }).where(eq(workspaces.id, c.ws.id));
    const r3 = (await startWorkflowRun(c.wf.id, "manual"))!;
    const apC = (await runOf(r3.id)).waitingApprovalId!;
    await db.update(approvals).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(approvals.id, apC));
    expect(await expireUnansweredApprovals()).toContain(apC);
    await advanceStuckWorkflowRuns();
    expect((await runOf(r3.id)).status).toBe("stopped");
  });

  it("a step that cannot start fails the run instead of leaving it running; a run left running is picked up", async () => {
    const { wf, emp } = await workflow((e) => [{ kind: "agent", employeeId: e, instruction: "x" }]);
    await db.update(employees).set({ status: "ARCHIVED" }).where(eq(employees.id, emp.id));
    await db.delete(employees).where(eq(employees.id, emp.id));
    const r = (await startWorkflowRun(wf.id, "manual"))!;
    const after = await runOf(r.id);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/^The run stopped: /);
    expect(await startWorkflowRun(wf.id, "manual")).not.toBeNull(); // not blocked by the failed one

    const b = await workflow((e) => [{ kind: "agent", employeeId: e, instruction: "x" }]);
    const [stale] = await db.insert(workflowRuns).values({ workflowId: b.wf.id, workspaceId: b.ws.id, steps: b.wf.steps, status: "running", createdAt: new Date(Date.now() - 10 * 60_000) }).returning();
    expect(await advanceStuckWorkflowRuns()).toContain(stale!.id);
    expect((await runOf(stale!.id)).status).toBe("waiting");
  });

  it("one open run at a time; a tainted proposal makes its tasks start tainted", async () => {
    const { wf } = await workflow((e) => [{ kind: "agent", employeeId: e, instruction: "x" }], { kind: "manual" }, { untrustedInput: true });
    const r = (await startWorkflowRun(wf.id, "manual"))!;
    expect(await startWorkflowRun(wf.id, "manual")).toBeNull();
    expect((await taskOf((await runOf(r.id)).waitingTaskId!)).untrustedInput).toBe(true);
  });

  it("the schedule starts a run when due and moves next_run_at on", async () => {
    const { wf } = await workflow((e) => [{ kind: "agent", employeeId: e, instruction: "x" }], { kind: "schedule", cron: "0 9 * * *", timezone: "Asia/Jakarta" });
    await tickWorkflows();
    const [after] = await db.select().from(workflows).where(eq(workflows.id, wf.id));
    expect(after!.nextRunAt).toBeInstanceOf(Date);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id))).toHaveLength(0);
    await db.update(workflows).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(workflows.id, wf.id));
    await tickWorkflows();
    expect(await db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, wf.id), eq(workflowRuns.trigger, "schedule")))).toHaveLength(1);
    expect((await db.select().from(workflows).where(eq(workflows.id, wf.id)))[0]!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("propose_workflow", () => {
  it("saves a draft that is off and never runs; unknown employees and invalid steps are refused", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "propose_workflow", enabled: true }] });
    const ctx = runContext(ws, emp, null);
    const propose = (args: Record<string, unknown>) => buildTools(ctx).find((d) => d.name === "propose_workflow")!.handler(args, {});
    const text = (r: { content: unknown[] }) => (r.content as { text: string }[])[0]!.text;

    const r = await propose({ name: "Follow-up leads", trigger: { kind: "schedule", cron: "0 8 * * 1", timezone: "Asia/Jakarta" }, steps: [{ kind: "agent", employeeId: emp.id, instruction: "Follow up." }, { kind: "approval", title: "Kirim?" }] });
    expect(text(r)).toMatch(/saved as a draft/);
    const [wf] = await db.select().from(workflows).where(eq(workflows.workspaceId, ws.id));
    expect(wf).toMatchObject({ enabled: false, proposedByEmployeeId: emp.id, untrustedInput: false, nextRunAt: null });
    await tickWorkflows();
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf!.id))).toHaveLength(0);

    const other = await makeEmployee((await makeWorkspace()).id);
    expect(text(await propose({ name: "x", trigger: { kind: "manual" }, steps: [{ kind: "agent", employeeId: other.id, instruction: "x" }] }))).toMatch(/Unknown employee id/);
    expect(text(await propose({ name: "x", trigger: { kind: "manual" }, steps: [{ kind: "notify", title: "x" }] }))).toMatch(/at least one employee step/);
    expect(text(await propose({ name: "x", trigger: { kind: "schedule", cron: "nope nope", timezone: "Asia/Jakarta" }, steps: [{ kind: "agent", employeeId: emp.id, instruction: "x" }] }))).toMatch(/cron/i);
  });
});
