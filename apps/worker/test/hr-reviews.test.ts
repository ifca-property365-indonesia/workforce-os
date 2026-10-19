import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, db, employeeMetrics, employees, hrReviews, incidents, metricScore, replays, steps } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { judgePasses, judgeReplay, setJudgeModelCall } from "../src/hr/judge";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => {
  setQueryImpl(null);
  setJudgeModelCall(null);
});

const ago = (min: number) => new Date(Date.now() - min * 60_000);

describe("HR metrics (C2)", () => {
  it("counts outcomes, incidents, approvals, changes requested, exact credits and active minutes of one employee", async () => {
    const ws = await makeWorkspace();
    const e = await makeEmployee(ws.id);
    const other = await makeEmployee(ws.id);
    const t1 = await makeTask(ws.id, e.id, { status: "DONE", completedAt: ago(100), title: "Report A" });
    await makeTask(ws.id, e.id, { status: "DONE", completedAt: ago(90) });
    await makeTask(ws.id, e.id, { status: "FAILED", completedAt: ago(80) });
    await makeTask(ws.id, e.id, { status: "DONE", completedAt: ago(60 * 24 * 40) }); // outside the 30 days
    await makeTask(ws.id, other.id, { status: "FAILED", completedAt: ago(10) });
    await db.insert(incidents).values({ workspaceId: ws.id, kind: "stalled", employeeId: e.id, summary: "x" });
    await db.insert(approvals).values([
      { workspaceId: ws.id, employeeId: e.id, toolName: "send_email", title: "a", payload: {}, status: "EXECUTED" },
      { workspaceId: ws.id, employeeId: e.id, toolName: "send_email", title: "b", payload: {}, status: "EXECUTED", editedPayload: { x: 1 } },
      { workspaceId: ws.id, employeeId: e.id, toolName: "send_email", title: "c", payload: {}, status: "REJECTED" },
    ]);
    await db.insert(auditLog).values({ workspaceId: ws.id, actorLabel: "p", action: "task.changes_requested", targetType: "task", targetId: t1.id });
    // steps at -60, -55 (5 min), -15 (40 min gap → 15 counted): 20 active minutes; one as a subagent (actor)
    await db.insert(steps).values([
      { workspaceId: ws.id, taskId: t1.id, employeeId: e.id, kind: "llm", name: "x", credits: 1.5, createdAt: ago(60) },
      { workspaceId: ws.id, taskId: t1.id, employeeId: e.id, kind: "llm", name: "x", credits: 2, createdAt: ago(55) },
      { workspaceId: ws.id, taskId: t1.id, employeeId: other.id, actorEmployeeId: e.id, kind: "llm", name: "x", credits: 0.5, createdAt: ago(15) },
      { workspaceId: ws.id, taskId: t1.id, employeeId: other.id, kind: "llm", name: "x", credits: 9, createdAt: ago(14) },
    ]);
    const m = await employeeMetrics(ws.id, e.id, 30);
    expect(m.tasks).toEqual({ done: 2, failed: 1, cancelled: 0, total: 3 });
    expect(m.successRate).toBe(0.667);
    expect(m.incidents).toEqual({ total: 1, byKind: { stalled: 1 } });
    expect(m.approvals).toEqual({ requested: 3, executed: 2, rejected: 1, edited: 1, expired: 0 });
    expect(m.changesRequested).toBe(1);
    expect(m.credits).toBe(4);
    expect(m.activeMinutes).toBe(20);
    expect(m.costliestTasks).toEqual([{ id: t1.id, title: "Report A", credits: 4 }]);
    // 67% success (-2), incidents 1/3 (-1), rejected 1/3 (-1), edited 1/3 (-0.5), changes 1/3 (-0.5) → 0 → 1
    expect(metricScore(m)).toBe(1);
  });

  it("scores 5 for clean work and nothing below three finished tasks", () => {
    const base = { days: 30, incidents: { total: 0, byKind: {} }, approvals: { requested: 0, executed: 0, rejected: 0, edited: 0, expired: 0 }, changesRequested: 0, credits: 0, activeMinutes: 0, costliestTasks: [] };
    expect(metricScore({ ...base, tasks: { done: 10, failed: 0, cancelled: 0, total: 10 }, successRate: 1 })).toBe(5);
    expect(metricScore({ ...base, tasks: { done: 2, failed: 0, cancelled: 0, total: 2 }, successRate: 1 })).toBeNull();
    expect(metricScore({ ...base, tasks: { done: 8, failed: 2, cancelled: 0, total: 10 }, successRate: 0.8 })).toBe(4);
  });
});

async function reviewSetup() {
  const ws = await makeWorkspace();
  const reviewee = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  await db.update(employees).set({ persona: "Careful analyst", instructions: "Write short reports." }).where(eq(employees.id, reviewee.id));
  const hr = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const task = await makeTask(ws.id, hr.id, { title: "HR review" });
  const metrics = await employeeMetrics(ws.id, reviewee.id, 30);
  const [review] = await db.insert(hrReviews).values({ workspaceId: ws.id, employeeId: reviewee.id, reviewerTaskId: task.id, metrics, metricScore: 4 }).returning();
  return { ws, reviewee, hr, task, review: review! };
}
const submit = (input: Record<string, unknown>): MockStep => ({ tool: "mcp__wfos__submit_hr_review", input });

describe("HR review run (C2)", () => {
  it("the HR employee sees the metrics and the profile as data, submits; new instructions start a replay, never apply directly", async () => {
    const s = await reviewSetup();
    const mock = mockRunner([
      submit({
        score: 4,
        summary: "Reliable output; two reports missed the client's format and were edited.",
        strengths: ["No incidents"],
        issues: ["Reports edited before sending"],
        recommendations: [{ type: "skill", text: "Assign the client report template skill" }],
        newInstructions: { instructions: "Write short reports in the client's template: summary, numbers, next steps.", reason: "Edited reports followed no template" },
      }),
      { result: "Submitted." },
    ]);
    setQueryImpl(mock.query as QueryFn);
    await runTask(s.task.id);

    expect(mock.lastPrompt).toContain("the platform's score from these numbers: 4");
    expect(mock.lastPrompt).toContain("<instructions>\nWrite short reports.\n</instructions>");
    const [rv] = await db.select().from(hrReviews).where(eq(hrReviews.id, s.review.id));
    expect(rv).toMatchObject({ status: "done", score: 4, strengths: ["No incidents"], recommendations: [{ type: "skill", text: "Assign the client report template skill" }] });
    const [rp] = await db.select().from(replays).where(eq(replays.id, rv!.replayId!));
    expect(rp).toMatchObject({ employeeId: s.reviewee.id, hrReviewId: s.review.id, status: "queued", proposed: { persona: "Careful analyst", instructions: "Write short reports in the client's template: summary, numbers, next steps." } });
    expect(transport.queued.some((q) => (q.data as { kind?: string; replayId?: string }).kind === "replay" && (q.data as { replayId: string }).replayId === rp!.id)).toBe(true);
    // the reviewee is unchanged until a judge (or a person) applies it
    expect((await db.select().from(employees).where(eq(employees.id, s.reviewee.id)))[0]!.instructions).toBe("Write short reports.");
  });

  it("a review that ends without a submission is an error; an invalid one is refused", async () => {
    const s = await reviewSetup();
    const mock = mockRunner([submit({ score: 9, summary: "short" }), { result: "Done." }]);
    setQueryImpl(mock.query as QueryFn);
    await runTask(s.task.id);
    expect(mock.calls[0]!.output).toMatch(/Invalid review/);
    expect((await db.select().from(hrReviews).where(eq(hrReviews.id, s.review.id)))[0]).toMatchObject({ status: "error" });
  });
});

describe("replay judge (C2)", () => {
  async function judged(verdicts: string[]) {
    const s = await reviewSetup();
    const [rp] = await db
      .insert(replays)
      .values({
        workspaceId: s.ws.id,
        employeeId: s.reviewee.id,
        hrReviewId: s.review.id,
        status: "done",
        proposed: { persona: "Careful analyst", instructions: "Use the template.", businessContext: "" },
        results: verdicts.map((_, i) => ({ taskId: `t${i}`, title: `Task ${i}`, oldOutput: "old", newOutput: "new", diff: "", credits: 0 })),
      })
      .returning();
    let n = 0;
    setJudgeModelCall(async (req) => {
      const v = verdicts[n++]!;
      return { text: v === "garbage" ? "I think it is fine" : JSON.stringify({ verdict: v, reason: `looked ${v}` }), model: req.model, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });
    const judge = await judgeReplay(rp!.id);
    const [after] = await db.select().from(replays).where(eq(replays.id, rp!.id));
    const [emp] = await db.select().from(employees).where(eq(employees.id, s.reviewee.id));
    return { s, judge, after: after!, emp: emp! };
  }

  it("passes when nothing got worse and something got better: applied on its own, version bumped, audited", async () => {
    const { s, judge, after, emp } = await judged(["better", "same", "better"]);
    expect(judge).toMatchObject({ passed: true });
    expect(after).toMatchObject({ status: "promoted", autoApplied: true });
    expect(emp).toMatchObject({ instructions: "Use the template.", instructionsVersion: 2 });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "employee.instructions_auto_promoted"), eq(auditLog.targetId, s.reviewee.id)))).toHaveLength(1);
    expect((await db.select().from(steps).where(and(eq(steps.employeeId, s.reviewee.id), eq(steps.name, "replay_judge")))).length).toBe(3);
  });

  it("one worse task, only 'same', or an invalid answer: nothing applies, a person decides", async () => {
    for (const v of [["better", "worse"], ["same", "same"], ["better", "garbage"]]) {
      const { judge, after, emp } = await judged(v);
      expect(judge!.passed).toBe(false);
      expect(after).toMatchObject({ status: "done", autoApplied: false });
      expect(emp.instructions).toBe("Write short reports.");
    }
    expect(judgePasses([])).toBe(false);
  });
});
