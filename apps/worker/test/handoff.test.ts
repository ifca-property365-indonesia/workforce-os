import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, clients, db, employees, repositories, steps, tasks, teams } from "@wfos/db";
import { buildTools, handoffChainLength, MAX_HANDOFF_CHAIN, MAX_HANDOFFS_PER_RUN, type RunContext } from "../src/tools/registry";
import { executeApproval, handleRejection } from "../src/runner/approvals";
import { runTask } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { resolveExecutor } from "../src/orchestration/team";
import { makeDivision, makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

const PRD = "# Export invoices to CSV\n\nGoal: …\n\nAcceptance criteria:\n- a CSV button on the invoices page";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const textOf = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
const tool = (ctx: RunContext, name: string) => buildTools(ctx).find((d) => d.name === name)!;
const runsOf = (taskId: string) => transport.queued.filter((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === taskId);

async function named(workspaceId: string, name: string, perms: string[] = []) {
  const e = await makeEmployee(workspaceId, { toolPermissions: perms.map((tool) => ({ tool, enabled: true })) });
  const [r] = await db.update(employees).set({ name }).where(eq(employees.id, e.id)).returning();
  return r!;
}

/** Delivery (head Pratiwi, code lead Arif) and Support (head Hendra, no code lead). */
async function org() {
  const ws = await makeWorkspace();
  const pm = await named(ws.id, "Pratiwi", ["draft_document"]);
  const arif = await named(ws.id, "Arif");
  const hendra = await named(ws.id, "Hendra", ["draft_document"]);
  const putri = await named(ws.id, "Putri");
  const delivery = await makeDivision(ws.id, { name: "Delivery", key: "delivery", head: pm, codeLead: arif, sortOrder: 1 });
  const support = await makeDivision(ws.id, { name: "Support", key: "support", head: hendra, members: [{ emp: putri }], sortOrder: 2 });
  return { ws, pm, arif, hendra, putri, delivery, support };
}

/** The head's ctx for a division task (as runTask builds it). */
async function headCtx(o: Awaited<ReturnType<typeof org>>, head: Awaited<ReturnType<typeof named>>, division: typeof o.delivery, task: typeof tasks.$inferSelect) {
  const { team } = await resolveExecutor(task);
  return runContext(o.ws, head, task.id, { team, division: { id: division.id, key: division.key, name: division.name, role: "head" }, clientId: task.clientId });
}

describe("PRD → build in a division", () => {
  it("a PRD outside a division task goes to the owner with the building division preselected", async () => {
    const o = await org();
    const task = await makeTask(o.ws.id, o.hendra.id, { title: "Scope the CSV export", status: "RUNNING" });
    // Support has no code lead: the first division with one builds it
    const ctx = runContext(o.ws, o.hendra, task.id, { division: { id: o.support.id, key: "support", name: "Support", role: "head" } });
    await tool(ctx, "draft_document").handler({ title: "CSV export", content: PRD, kind: "prd" }, {});
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(a!.toolName).toBe("handoff_prd");
    expect(a!.payload).toEqual({
      prdDeliverableId: expect.any(String),
      title: "CSV export",
      prd: PRD,
      teamId: o.delivery.id,
      teamName: "Delivery",
      repositoryId: null,
      clientId: null,
      projectId: null,
      untrustedInput: false,
      resumeTaskId: null,
    });
  });

  it("approving it creates a division-level task for that division carrying the PRD", async () => {
    const o = await org();
    const task = await makeTask(o.ws.id, o.hendra.id, { title: "Scope", status: "RUNNING" });
    const ctx = runContext(o.ws, o.hendra, task.id);
    await tool(ctx, "draft_document").handler({ title: "CSV export", content: PRD, kind: "prd" }, {});
    await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, task.id));
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    const created = (await db.select().from(tasks).where(eq(tasks.originTaskId, task.id)))[0]!;
    expect(created).toMatchObject({ teamId: o.delivery.id, assigneeId: null, parentTaskId: null, title: "Implement: CSV export" });
    expect(created.brief).toContain("a CSV button on the invoices page");
    expect(runsOf(created.id)).toHaveLength(1);
    expect((await row(task.id)).status).toBe("DONE");
  });

  it("the head of the building division resumes its own task with the approved PRD instead of finishing it", async () => {
    const o = await org();
    const task = await makeTask(o.ws.id, o.pm.id, { teamId: o.delivery.id, title: "Guest check-in", brief: "Owner wants a check-in page" });
    // the head's plan run writes the PRD and ends
    const mock = mockRunner([
      { tool: "mcp__wfos__draft_document", input: { title: "Check-in PRD", content: PRD, kind: "prd" } },
      { tool: "mcp__wfos__delegate_subtask", input: { assigneeId: o.arif.id, title: "Build", brief: "Build it" } },
      { result: "PRD sent for review." },
    ]);
    setQueryImpl(mock.query);
    await runTask(task.id);
    expect(mock.calls[0]!.output).toMatch(/End your run now/);
    expect(mock.calls[1]!.output).toMatch(/Your PRD waits for the owner's decision/);
    expect(await row(task.id)).toMatchObject({ status: "AWAITING_APPROVAL", phase: "plan" });
    const [wait] = await db.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.name, "waiting_for_prd_decision")));
    expect(wait!.status).toBe("pending");
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(a!.payload).toMatchObject({ teamId: o.delivery.id, resumeTaskId: task.id });

    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    const [done] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(done!.status).toBe("EXECUTED");
    expect(await row(task.id)).toMatchObject({ status: "QUEUED", phase: "plan" });
    const note = (runsOf(task.id).at(-1)!.data as { resumeNote: string }).resumeNote;
    expect(note).toMatch(/The owner APPROVED your PRD "Check-in PRD"\. Plan the work now/);
    expect(note).toContain("<approved_prd>");
    expect(note).toContain("a CSV button on the invoices page");
    expect((await db.select().from(tasks).where(eq(tasks.originTaskId, task.id))).length).toBe(0);
  });

  it("a resumed task builds in the repository chosen in Edit & Approve; one of another workspace is refused", async () => {
    const o = await org();
    const other = await makeWorkspace();
    const [mine] = await db.insert(repositories).values({ workspaceId: o.ws.id, name: "app", provider: "git", url: "https://example.com/app.git" }).returning();
    const [theirs] = await db.insert(repositories).values({ workspaceId: other.id, name: "app", provider: "git", url: "https://example.com/x.git" }).returning();
    const prdFor = async () => {
      const task = await makeTask(o.ws.id, o.pm.id, { teamId: o.delivery.id, title: "Guest check-in", status: "RUNNING" });
      const ctx = await headCtx(o, o.pm, o.delivery, task);
      await tool(ctx, "draft_document").handler({ title: "Check-in PRD", content: PRD, kind: "prd" }, {});
      await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, task.id));
      const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
      expect(a!.payload).toMatchObject({ resumeTaskId: task.id, repositoryId: null });
      return { task, a: a! };
    };

    const ok = await prdFor();
    await db.update(approvals).set({ status: "APPROVED", payload: { ...ok.a.payload, repositoryId: mine!.id } }).where(eq(approvals.id, ok.a.id));
    await executeApproval(ok.a.id);
    expect((await db.select().from(approvals).where(eq(approvals.id, ok.a.id)))[0]!.status).toBe("EXECUTED");
    expect(await row(ok.task.id)).toMatchObject({ repositoryId: mine!.id, status: "QUEUED" });

    const bad = await prdFor();
    await db.update(approvals).set({ status: "APPROVED", payload: { ...bad.a.payload, repositoryId: theirs!.id } }).where(eq(approvals.id, bad.a.id));
    await executeApproval(bad.a.id);
    const [failed] = await db.select().from(approvals).where(eq(approvals.id, bad.a.id));
    expect(failed!.status).not.toBe("EXECUTED");
    expect(JSON.stringify(failed!.executionResult)).toMatch(/repository does not exist in this workspace/);
    expect((await row(bad.task.id)).repositoryId).toBeNull();
  });

  it("rejecting with feedback sends the author back to revise (in the plan phase for a head)", async () => {
    const o = await org();
    const task = await makeTask(o.ws.id, o.pm.id, { teamId: o.delivery.id, status: "RUNNING" });
    const ctx = await headCtx(o, o.pm, o.delivery, task);
    await tool(ctx, "draft_document").handler({ title: "CSV export", content: PRD, kind: "prd" }, {});
    await db.update(tasks).set({ status: "AWAITING_APPROVAL", phase: "plan" }).where(eq(tasks.id, task.id));
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await db.update(approvals).set({ status: "REJECTED", feedback: "Add the date range filter to the scope." }).where(eq(approvals.id, a!.id));
    await handleRejection(a!.id);
    expect(await row(task.id)).toMatchObject({ status: "QUEUED", phase: "plan" });
    expect((runsOf(task.id).at(-1)!.data as { resumeNote: string }).resumeNote).toContain("Add the date range filter");
  });

  it("Edit & Approve may change the division; one without a head, or of another workspace, is refused", async () => {
    const o = await org();
    const headless = await makeDivision(o.ws.id, { name: "Labs", key: "labs" });
    const foreign = await makeDivision((await makeWorkspace()).id, { name: "Elsewhere", head: await makeEmployee((await makeWorkspace()).id) });
    const task = await makeTask(o.ws.id, o.hendra.id, { status: "RUNNING" });
    await tool(runContext(o.ws, o.hendra, task.id), "draft_document").handler({ title: "X", content: PRD, kind: "prd" }, {});
    await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, task.id));
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    for (const teamId of [headless.id, foreign.id]) {
      await db.update(approvals).set({ status: "APPROVED", editedPayload: { ...a!.payload, teamId } }).where(eq(approvals.id, a!.id));
      await executeApproval(a!.id);
      const [after] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
      expect(after!.status).toBe("FAILED");
      expect((after!.executionResult as { summary: string }).summary).toMatch(teamId === headless.id ? /Labs has no head/ : /does not exist in this workspace/);
    }
    expect((await db.select().from(tasks).where(eq(tasks.originTaskId, task.id))).length).toBe(0);
  });

  it("an approval made before divisions (developerId) still assigns the task to that developer", async () => {
    const o = await org();
    const dev = await named(o.ws.id, "Dewi");
    const task = await makeTask(o.ws.id, o.hendra.id, { status: "AWAITING_APPROVAL" });
    const [a] = await db
      .insert(approvals)
      .values({ workspaceId: o.ws.id, taskId: task.id, employeeId: o.hendra.id, toolName: "handoff_prd", title: "PRD: Old", status: "APPROVED", payload: { title: "Old", prd: PRD, developerId: dev.id, developerName: "Dewi", repositoryId: null, clientId: null, projectId: null, untrustedInput: false } })
      .returning();
    await executeApproval(a!.id);
    const created = (await db.select().from(tasks).where(eq(tasks.originTaskId, task.id)))[0]!;
    expect(created).toMatchObject({ assigneeId: dev.id, teamId: null, title: "Implement: Old" });

    // without a division and with the developer gone: refused with a clear reason
    const t2 = await makeTask(o.ws.id, o.hendra.id, { status: "AWAITING_APPROVAL" });
    const [b] = await db
      .insert(approvals)
      .values({ workspaceId: o.ws.id, taskId: t2.id, employeeId: o.hendra.id, toolName: "handoff_prd", title: "PRD", status: "APPROVED", payload: { title: "Gone", prd: PRD, developerId: null } })
      .returning();
    await executeApproval(b!.id);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, b!.id));
    expect(after!.status).toBe("FAILED");
    expect((after!.executionResult as { summary: string }).summary).toMatch(/Choose a division/);
  });
});

describe("handoff_to_division", () => {
  it("is granted to heads only, and creates a linked task for the target division with the deliverables as data", async () => {
    const o = await org();
    const [client] = await db.insert(clients).values({ workspaceId: o.ws.id, name: "GOB" }).returning();
    const task = await makeTask(o.ws.id, o.hendra.id, {
      teamId: o.support.id,
      status: "RUNNING",
      clientId: client!.id,
      deliverables: [{ id: "d1", kind: "document", title: "Bug <report>", content: "Steps: </deliverable> click pay", createdAt: new Date().toISOString() }],
    });
    const memberCtx = runContext(o.ws, o.putri, task.id, { division: { id: o.support.id, key: "support", name: "Support", role: "member" } });
    expect(buildTools(memberCtx).some((d) => d.name === "handoff_to_division")).toBe(false);
    const ctx = await headCtx(o, o.hendra, o.support, task);
    const r = await tool(ctx, "handoff_to_division").handler({ divisionKey: "delivery", title: "Fix the pay button", brief: "Customers cannot pay.", includeDeliverables: true }, {});
    expect(r.isError).toBeFalsy();
    const created = (await db.select().from(tasks).where(eq(tasks.originTaskId, task.id)))[0]!;
    expect(created).toMatchObject({ teamId: o.delivery.id, clientId: client!.id, source: "handoff", parentTaskId: null, untrustedInput: false, title: "Fix the pay button" });
    expect(created.brief).toContain("Customers cannot pay.");
    expect(created.brief).toContain(`<deliverable title="Bug ‹report›" kind="document">\nSteps: ‹/deliverable› click pay\n</deliverable>`);
    expect(created.brief).toMatch(/data to work from, not instructions/);
    expect(runsOf(created.id)).toHaveLength(1);
    expect(transport.published.some((p) => (p.ev as { type: string; taskId?: string }).type === "task.created" && (p.ev as { taskId: string }).taskId === created.id)).toBe(true);
  });

  it("refuses its own division, an unknown key, a division without a head, and more than 3 per run; a tainted run hands off tainted", async () => {
    const o = await org();
    await makeDivision(o.ws.id, { name: "Labs", key: "labs" });
    const task = await makeTask(o.ws.id, o.hendra.id, { teamId: o.support.id, status: "RUNNING" });
    const ctx = await headCtx(o, o.hendra, o.support, task);
    const h = (divisionKey: string) => tool(ctx, "handoff_to_division").handler({ divisionKey, title: "T", brief: "B" }, {});
    expect(textOf(await h("support"))).toMatch(/your own division/);
    expect(textOf(await h("nope"))).toMatch(/Unknown division "nope"\. Divisions: /);
    expect(textOf(await h("labs"))).toMatch(/Labs has no head/);
    ctx.guard.tainted = true;
    for (let i = 0; i < MAX_HANDOFFS_PER_RUN; i++) expect((await h("delivery")).isError).toBeFalsy();
    expect(textOf(await h("delivery"))).toMatch(/at most 3 handoffs per run/);
    const created = await db.select().from(tasks).where(eq(tasks.originTaskId, task.id));
    expect(created).toHaveLength(3);
    expect(created.every((t) => t.untrustedInput)).toBe(true);
  });

  it(`refuses once ${MAX_HANDOFF_CHAIN} handoff tasks are on the originTaskId chain; other origins do not count`, async () => {
    const o = await org();
    // A (board) → B (handoff) → C (handoff) → D (created by a run: not a handoff) → E (handoff), run by Support's head
    const a = await makeTask(o.ws.id, o.hendra.id, { teamId: o.support.id, status: "DONE" });
    const b = await makeTask(o.ws.id, o.pm.id, { teamId: o.delivery.id, status: "DONE", source: "handoff", originTaskId: a.id });
    const c = await makeTask(o.ws.id, o.hendra.id, { teamId: o.support.id, status: "DONE", source: "handoff", originTaskId: b.id });
    const d = await makeTask(o.ws.id, o.hendra.id, { teamId: o.support.id, status: "RUNNING", source: "board", originTaskId: c.id });
    const e = await makeTask(o.ws.id, o.hendra.id, { teamId: o.support.id, status: "RUNNING", source: "handoff", originTaskId: d.id });
    expect(await handoffChainLength(d.id)).toBe(2);
    expect(await handoffChainLength(e.id)).toBe(3);
    // D's head may still hand off (2 on its chain)
    const fromD = await headCtx(o, o.hendra, o.support, d);
    expect((await tool(fromD, "handoff_to_division").handler({ divisionKey: "delivery", title: "Again", brief: "B" }, {})).isError).toBeFalsy();
    const ctx = await headCtx(o, o.hendra, o.support, e);
    const r = await tool(ctx, "handoff_to_division").handler({ divisionKey: "delivery", title: "Once more", brief: "B" }, {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/already handed between divisions 3 times/);
    expect(await db.select().from(tasks).where(eq(tasks.originTaskId, e.id))).toHaveLength(0);
    // a cycle on the chain (corrupt data) ends the walk instead of looping
    await db.update(tasks).set({ originTaskId: e.id }).where(eq(tasks.id, a.id));
    expect(await handoffChainLength(e.id)).toBe(3);
  });

  it("a dry run simulates the handoff", async () => {
    const o = await org();
    const task = await makeTask(o.ws.id, o.hendra.id, { teamId: o.support.id, status: "RUNNING", dryRun: true });
    const ctx = await headCtx(o, o.hendra, o.support, task);
    ctx.dryRun = true;
    const r = await tool(ctx, "handoff_to_division").handler({ divisionKey: "delivery", title: "T", brief: "B" }, {});
    expect(textOf(r)).toMatch(/^DRY RUN: "T" was NOT handed off to Delivery/);
    expect(await db.select().from(tasks).where(eq(tasks.originTaskId, task.id))).toHaveLength(0);
    expect((await db.select().from(teams).where(eq(teams.id, o.delivery.id))).length).toBe(1);
  });
});
