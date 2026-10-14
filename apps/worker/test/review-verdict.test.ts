import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentMessages, db, incidents, steps, tasks, teamMembers, teams } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { requestRevisions, reviewPrompt } from "../src/orchestration/team";
import { MAX_REVISIONS_PER_SUBTASK, revisionRefusal } from "../src/orchestration/revisions";
import { buildTools } from "../src/tools/registry";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const enqueuedRuns = (taskId: string) => transport.queued.filter((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === taskId);
const textOf = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

/** A head reviewing one DONE subtask that already had `used` revisions. */
async function reviewWorld(used = 0) {
  const ws = await makeWorkspace();
  const head = await makeEmployee(ws.id, { toolPermissions: [] });
  const member = await makeEmployee(ws.id, { toolPermissions: [] });
  const [team] = await db.insert(teams).values({ workspaceId: ws.id, name: "Delivery", leadId: head.id }).returning();
  await db.insert(teamMembers).values([head, member].map((e) => ({ teamId: team!.id, employeeId: e.id })));
  const parent = await makeTask(ws.id, head.id, { teamId: team!.id, status: "RUNNING", phase: "review", title: "Buku Tamu: kolom Instansi", brief: "Add Instansi" });
  const child = await makeTask(ws.id, member.id, { teamId: team!.id, parentTaskId: parent.id, source: "team", status: "DONE", title: "Build", result: "built, no tests" });
  for (let i = 0; i < used; i++) {
    await db.insert(agentMessages).values({ workspaceId: ws.id, taskId: child.id, fromEmployeeId: head.id, toEmployeeId: member.id, intent: "review", content: `revision ${i + 1}` });
  }
  const ctx = () => runContext(ws, head, parent.id, { team: { teamId: team!.id, role: "lead", phase: "review", memberIds: [member.id] } });
  return { ws, head, member, team: team!, parent, child, ctx };
}

const revise = (subtaskId: string, feedback = "Add the tests for the 120-character limit"): MockStep => ({ tool: "mcp__wfos__request_revision", input: { subtaskId, feedback } });

describe("request_revision: two per subtask, refused when the head calls it", () => {
  it("allows a first and a second revision, then refuses the third with the head's options", async () => {
    expect(MAX_REVISIONS_PER_SUBTASK).toBe(2);
    for (const used of [0, 1]) {
      const w = await reviewWorld(used);
      const ctx = w.ctx();
      const r = await buildTools(ctx).find((d) => d.name === "request_revision")!.handler({ subtaskId: w.child.id, feedback: "Add the tests please" }, {});
      expect(r.isError).toBeFalsy();
      expect(ctx.revisionRequests).toHaveLength(1);
      expect(await requestRevisions(w.ws.id, w.parent.id, w.head.id, ctx.revisionRequests)).toBe(1);
    }
    const w = await reviewWorld(2);
    const ctx = w.ctx();
    const r = await buildTools(ctx).find((d) => d.name === "request_revision")!.handler({ subtaskId: w.child.id, feedback: "Add the tests please" }, {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/"Build" has already had its 2 revisions, so it cannot be sent back again\. Decide now with finish_review: outcome "accept".*outcome "fail"/);
    expect(ctx.revisionRequests).toHaveLength(0);
    expect(ctx.refusedRevisions).toBe(1);
  });

  it("refuses a subtask that is not DONE, of another task, or already requested in this review", async () => {
    const w = await reviewWorld();
    expect(await revisionRefusal({ parentTaskId: w.parent.id, subtaskId: w.child.id, pending: [{ taskId: w.child.id }] })).toMatch(/already requested in this review/);
    const other = await makeTask(w.ws.id, w.member.id, { status: "DONE" });
    expect(await revisionRefusal({ parentTaskId: w.parent.id, subtaskId: other.id, pending: [] })).toMatch(/is not a subtask of this task/);
    await db.update(tasks).set({ status: "FAILED" }).where(eq(tasks.id, w.child.id));
    expect(await revisionRefusal({ parentTaskId: w.parent.id, subtaskId: w.child.id, pending: [] })).toMatch(/is FAILED: .*retry_subtask or reassign_subtask/);
  });

  it("the review prompt shows the revisions used and asks for a verdict", async () => {
    const w = await reviewWorld(2);
    const p = await reviewPrompt(await row(w.parent.id));
    expect(p).toContain("Revisions used: 2 of 2 (none left: accept it with notes or fail the task)");
    expect(p).toMatch(/at most 2 revisions per subtask/);
    expect(p).toMatch(/finish_review: outcome "accept".*outcome "fail"/);
  });
});

describe("a head's review never ends DONE silently when it wanted changes", () => {
  it("the trial: a refused revision and no verdict → the review goes back to the head once, then the task fails", async () => {
    const w = await reviewWorld(2);
    setQueryImpl(mockRunner([revise(w.child.id), { result: "Asked Arif to add the tests." }]).query);
    await runTask(w.parent.id);
    expect(await row(w.parent.id)).toMatchObject({ status: "RUNNING", phase: "review" });
    const [nv] = await db.select().from(steps).where(and(eq(steps.taskId, w.parent.id), eq(steps.name, "team_review_no_verdict")));
    expect(nv).toMatchObject({ status: "flagged" });
    const runs = enqueuedRuns(w.parent.id);
    expect(runs).toHaveLength(1);
    expect(String((runs[0]!.data as { resumeNote?: string }).resumeNote ?? JSON.stringify(runs[0]!.data))).toMatch(/finish_review/);
    expect((await row(w.child.id)).status).toBe("DONE");

    // the head ignores it again: FAILED with an incident for a person
    setQueryImpl(mockRunner([revise(w.child.id), { result: "Asked again." }]).query);
    await runTask(w.parent.id);
    const p = await row(w.parent.id);
    expect(p.status).toBe("FAILED");
    expect(p.error).toMatch(/The review ended without a verdict/);
    expect(await db.select().from(incidents).where(eq(incidents.taskId, w.parent.id))).toHaveLength(1);
  });

  it("finish_review fail ends the task FAILED with the head's notes", async () => {
    const w = await reviewWorld(2);
    setQueryImpl(
      mockRunner([revise(w.child.id), { tool: "mcp__wfos__finish_review", input: { outcome: "fail", notes: "No tests for the 120-character limit; criterion 5 not met." } }, { result: "Not accepted." }]).query,
    );
    await runTask(w.parent.id);
    const p = await row(w.parent.id);
    expect(p.status).toBe("FAILED");
    expect(p.error).toBe("The division head did not accept the work: No tests for the 120-character limit; criterion 5 not met.");
    expect(await db.select().from(steps).where(and(eq(steps.taskId, w.parent.id), eq(steps.name, "team_review_failed")))).toHaveLength(1);
  });

  it("finish_review accept ends the task DONE (also after a refused revision)", async () => {
    const w = await reviewWorld(2);
    setQueryImpl(mockRunner([revise(w.child.id), { tool: "mcp__wfos__finish_review", input: { outcome: "accept", notes: "Usable; tests for the limit follow in a new task." } }, { result: "Accepted with notes." }]).query);
    await runTask(w.parent.id);
    expect(await row(w.parent.id)).toMatchObject({ status: "DONE", result: "Accepted with notes." });
    const [s] = await db.select().from(steps).where(and(eq(steps.taskId, w.parent.id), eq(steps.name, "team_review_accepted")));
    expect(s!.output).toEqual({ notes: "Usable; tests for the limit follow in a new task." });
  });

  it("a plain review that wanted nothing still finishes DONE", async () => {
    const w = await reviewWorld();
    setQueryImpl(mockRunner([{ result: "All criteria met." }]).query);
    await runTask(w.parent.id);
    expect((await row(w.parent.id)).status).toBe("DONE");
  });

  it("a revision request sends the work back; finish_review in the same run is refused", async () => {
    const w = await reviewWorld(1);
    const mock = mockRunner([revise(w.child.id), { tool: "mcp__wfos__finish_review", input: { outcome: "accept", notes: "fine anyway" } }, { result: "Sent back." }]);
    setQueryImpl(mock.query);
    await runTask(w.parent.id);
    expect(mock.calls[1]!.output).toMatch(/already sent work back/);
    expect(await row(w.parent.id)).toMatchObject({ status: "RUNNING", phase: "wait" });
    expect((await row(w.child.id)).status).toBe("QUEUED");
  });
});
