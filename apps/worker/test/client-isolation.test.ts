import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentMessages, approvals, chunks, clients, db, documents, invoices, memories, memoryEvents, tasks, teams } from "@wfos/db";
import { buildTools, unreadMessagesFor, type RunContext } from "../src/tools/registry";
import { recallMemories, recentWorkBrief } from "../src/runner/prompt";
import { handleRejection } from "../src/runner/approvals";
import { tidyEmployeeMemories } from "../src/scheduler/memory-tidy";
import { runTask } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { makeApproval, makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

const vec = Array.from({ length: 384 }, (_, i) => (i % 7) / 7 + 0.01);
const textOf = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
const tool = (ctx: RunContext, name: string) => buildTools(ctx).find((d) => d.name === name)!;

const withTools = (ctx: RunContext, names: string[]): RunContext => ({
  ...ctx,
  employee: { ...ctx.employee, toolPermissions: [...ctx.employee.toolPermissions, ...names.map((t) => ({ tool: t, enabled: true }))] },
});

/** Two clients (A, B) with a document and a memory each, plus general ones. */
async function world() {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id, {
    toolPermissions: ["kb_search", "memory_search", "memory_save", "get_client", "list_tasks"].map((t) => ({ tool: t, enabled: true })),
  });
  const [a] = await db.insert(clients).values({ workspaceId: ws.id, name: "Alpha Co", code: "ALPHA" }).returning();
  const [b] = await db.insert(clients).values({ workspaceId: ws.id, name: "Beta Co", code: "BETA" }).returning();
  const doc = async (name: string, clientId: string | null, content: string) => {
    const [d] = await db.insert(documents).values({ workspaceId: ws.id, name, mime: "text/markdown", size: 10, storagePath: "/x", clientId, status: "indexed" }).returning();
    await db.insert(chunks).values({ workspaceId: ws.id, documentId: d!.id, ordinal: 0, content, embedding: vec });
  };
  await doc("Handbook", null, "General: invoices are due in 30 days.");
  await doc("Alpha contract", a!.id, "Alpha: the rate is 100 per hour.");
  await doc("Beta contract", b!.id, "Beta: the rate is 250 per hour (confidential).");
  const mem = (content: string, clientId: string | null, kind = "fact") => db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, clientId, kind, content, embedding: vec });
  await mem("General: write in short paragraphs.", null);
  await mem("Alpha prefers Bahasa Indonesia.", a!.id);
  await mem("Beta's CFO is Mr. Secret.", b!.id);
  await mem("Beta reviewer: never mention Alpha.", b!.id, "feedback");
  const taskA = await makeTask(ws.id, emp.id, { clientId: a!.id, title: "Alpha status report", status: "RUNNING" });
  const ctxA = runContext(ws, emp, taskA.id, { clientId: a!.id });
  return { ws, emp, a: a!, b: b!, taskA, ctxA };
}

describe("client isolation: a task of client A never sees client B's knowledge, memory or work", () => {
  it("kb_search returns general and client A documents only (no client: general only)", async () => {
    const w = await world();
    const out = textOf(await tool(w.ctxA, "kb_search").handler({ query: "rate per hour", limit: 10 }, {}));
    expect(out).toContain("[Handbook §1]");
    expect(out).toContain("[Alpha contract §1]");
    expect(out).not.toContain("Beta");
    const general = runContext(w.ws, w.emp, null);
    const g = textOf(await tool(general, "kb_search").handler({ query: "rate per hour", limit: 10 }, {}));
    expect(g).toContain("Handbook");
    expect(g).not.toContain("Alpha");
    expect(g).not.toContain("Beta");
  });

  it("memory_search and recalled memories: general and client A only", async () => {
    const w = await world();
    const out = textOf(await tool(w.ctxA, "memory_search").handler({ query: "client preferences" }, {}));
    expect(out).toContain("Alpha prefers Bahasa Indonesia.");
    expect(out).toContain("General: write in short paragraphs.");
    expect(out).not.toContain("Beta");
    const recalled = (await recallMemories(w.emp.id, "status report", w.a.id)).map((m) => m.content).join("\n");
    expect(recalled).toContain("Alpha prefers");
    expect(recalled).not.toContain("Beta");
    const chat = (await recallMemories(w.emp.id, "anything")).map((m) => m.content).join("\n");
    expect(chat).not.toMatch(/Alpha|Beta/);
  });

  it("memory_save stores the task's client; it cannot replace a memory of another scope", async () => {
    const w = await world();
    await tool(w.ctxA, "memory_save").handler({ content: "Alpha pays by transfer." }, {});
    const mine = (content: string) => db.select().from(memories).where(and(eq(memories.employeeId, w.emp.id), eq(memories.content, content)));
    const [m] = await mine("Alpha pays by transfer.");
    expect(m!.clientId).toBe(w.a.id);
    // the journal keeps the client, so an undo in the web puts the memory back in the same scope
    const [ev] = await db.select().from(memoryEvents).where(eq(memoryEvents.memoryId, m!.id));
    expect(ev!.after).toMatchObject({ content: "Alpha pays by transfer.", clientId: w.a.id });
    const [beta] = await mine("Beta's CFO is Mr. Secret.");
    const [general] = await mine("General: write in short paragraphs.");
    expect(textOf(await tool(w.ctxA, "memory_save").handler({ content: "New fact here.", supersedes: beta!.id }, {}))).toMatch(/no memory of yours has that id/);
    expect(textOf(await tool(w.ctxA, "memory_save").handler({ content: "Another fact.", supersedes: general!.id }, {}))).toMatch(/another scope/);
  });

  it("recent work lists tasks of the same client or of no client", async () => {
    const w = await world();
    await makeTask(w.ws.id, w.emp.id, { clientId: w.b.id, title: "Beta pricing review", status: "DONE" });
    await makeTask(w.ws.id, w.emp.id, { title: "Internal tidy-up", status: "DONE" });
    await makeTask(w.ws.id, w.emp.id, { clientId: w.a.id, title: "Alpha kickoff", status: "DONE" });
    const brief = await recentWorkBrief(w.emp.id, { excludeTaskId: w.taskA.id, clientId: w.a.id });
    expect(brief).toContain("Alpha kickoff");
    expect(brief).toContain("Internal tidy-up");
    expect(brief).not.toContain("Beta");
  });

  it("get_client and list_tasks stay on the task's client", async () => {
    const w = await world();
    await makeTask(w.ws.id, w.emp.id, { clientId: w.b.id, title: "Beta pricing review", status: "DONE", result: "Beta pays 250" });
    expect(textOf(await tool(w.ctxA, "get_client").handler({ clientId: w.b.id }, {}))).toMatch(/another client/);
    expect(textOf(await tool(w.ctxA, "get_client").handler({ clientId: w.a.id }, {}))).toContain("Alpha Co");
    const list = textOf(await tool(w.ctxA, "list_tasks").handler({ limit: 30 }, {}));
    expect(list).toContain("Alpha status report");
    expect(list).not.toContain("Beta");
    expect(textOf(await tool(w.ctxA, "list_tasks").handler({ clientId: w.b.id }, {}))).toMatch(/another client/);
  });

  it("list_clients and list_invoices show the task's client only (general work sees all)", async () => {
    const w = await world();
    const ctx = withTools(w.ctxA, ["list_clients", "list_invoices"]);
    await db.insert(invoices).values([
      { workspaceId: w.ws.id, clientId: w.a.id, number: "INV-A-1", total: 100 },
      { workspaceId: w.ws.id, clientId: w.b.id, number: "INV-B-1", total: 250 },
    ]);
    const cl = textOf(await tool(ctx, "list_clients").handler({}, {}));
    expect(cl).toContain("Alpha Co");
    expect(cl).not.toContain("Beta");
    const inv = textOf(await tool(ctx, "list_invoices").handler({}, {}));
    expect(inv).toContain("INV-A-1");
    expect(inv).not.toContain("INV-B-1");
    expect(textOf(await tool(ctx, "list_invoices").handler({ clientId: w.b.id }, {}))).toMatch(/another client/);
    const general = withTools(runContext(w.ws, w.emp, null), ["list_clients", "list_invoices"]);
    expect(textOf(await tool(general, "list_clients").handler({}, {}))).toContain("Beta Co");
    expect(textOf(await tool(general, "list_invoices").handler({}, {}))).toContain("INV-B-1");
  });

  it("invoices, emails and new tasks refuse another client; create_task defaults to the task's client", async () => {
    const w = await world();
    const ctx = withTools(w.ctxA, ["draft_invoice", "send_invoice", "draft_email", "send_email", "create_task"]);
    const inv = { invoiceNumber: "INV-9", lines: [{ description: "Work", quantity: 1, unitPrice: 10 }], dueDate: "2026-11-01" };
    for (const name of ["draft_invoice", "send_invoice"]) {
      const r = await tool(ctx, name).handler({ ...inv, clientId: w.b.id }, {});
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/another client/);
    }
    const mail = { to: ["cfo@beta.example"], subject: "Rates", body: "Hello", clientId: w.b.id };
    for (const name of ["draft_email", "send_email"]) {
      const r = await tool(ctx, name).handler(mail, {});
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/another client/);
    }
    expect(textOf(await tool(ctx, "create_task").handler({ title: "Beta thing", brief: "x", clientId: w.b.id }, {}))).toMatch(/another client/);
    expect((await tool(ctx, "create_task").handler({ title: "Alpha follow-up call", brief: "x", start: false }, {})).isError).toBeFalsy();
    const [created] = await db.select().from(tasks).where(eq(tasks.title, "Alpha follow-up call"));
    expect(created!.clientId).toBe(w.a.id);
    // nothing for client B was written
    expect(await db.select().from(invoices).where(eq(invoices.clientId, w.b.id))).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.taskId, w.taskA.id))).toHaveLength(0);
  });

  it("agent messages carry the sender's client; a run sees general ones and its own client's only", async () => {
    const w = await world();
    const colleague = await makeEmployee(w.ws.id);
    const ctx = withTools(w.ctxA, ["message_teammate"]);
    expect((await tool(ctx, "message_teammate").handler({ toEmployeeId: colleague.id, intent: "update", content: "Alpha signed." }, {})).isError).toBeFalsy();
    const [sent] = await db.select().from(agentMessages).where(eq(agentMessages.toEmployeeId, colleague.id));
    expect(sent!.clientId).toBe(w.a.id);
    await db.insert(agentMessages).values([
      { workspaceId: w.ws.id, fromEmployeeId: w.emp.id, toEmployeeId: colleague.id, intent: "update", content: "General: office closed Friday." },
      { workspaceId: w.ws.id, fromEmployeeId: w.emp.id, toEmployeeId: colleague.id, intent: "update", content: "Beta: the CFO is Mr. Secret.", clientId: w.b.id },
    ]);
    const forA = (await unreadMessagesFor(colleague.id, w.a.id)).map((m) => m.content);
    expect(forA.sort()).toEqual(["Alpha signed.", "General: office closed Friday."]);
    // Beta's message stays unread until a run for Beta (general work does not see it either)
    expect(await unreadMessagesFor(colleague.id, null)).toHaveLength(0);
    expect((await unreadMessagesFor(colleague.id, w.b.id)).map((m) => m.content)).toEqual(["Beta: the CFO is Mr. Secret."]);
  });

  it("delegate_subtask's message carries the client of the division task", async () => {
    const w = await world();
    const member = await makeEmployee(w.ws.id);
    const [team] = await db.insert(teams).values({ workspaceId: w.ws.id, name: "Delivery", leadId: w.emp.id }).returning();
    const parent = await makeTask(w.ws.id, w.emp.id, { clientId: w.a.id, teamId: team!.id, status: "RUNNING" });
    const ctx = runContext(w.ws, w.emp, parent.id, { clientId: w.a.id, team: { teamId: team!.id, role: "lead", phase: "plan", memberIds: [member.id] } });
    expect((await tool(ctx, "delegate_subtask").handler({ assigneeId: member.id, title: "Draft", brief: "Draft it" }, {})).isError).toBeFalsy();
    const [m] = await db.select().from(agentMessages).where(eq(agentMessages.toEmployeeId, member.id));
    expect(m!.clientId).toBe(w.a.id);
  });

  it("a whole run of a client A task: nothing of client B reaches the prompt", async () => {
    const w = await world();
    await makeTask(w.ws.id, w.emp.id, { clientId: w.b.id, title: "Beta pricing review", status: "DONE" });
    const t = await makeTask(w.ws.id, w.emp.id, { clientId: w.a.id, title: "Alpha follow-up" });
    const mock = mockRunner([{ result: "ok" }]);
    setQueryImpl(mock.query);
    // a colleague's message sent from a client B run is not in the inbox of this client A run
    const colleague = await makeEmployee(w.ws.id);
    await db.insert(agentMessages).values({ workspaceId: w.ws.id, fromEmployeeId: colleague.id, toEmployeeId: w.emp.id, intent: "update", content: "Beta discount is 40%.", clientId: w.b.id });
    await runTask(t.id);
    expect(mock.lastPrompt).toContain("Alpha prefers Bahasa Indonesia.");
    expect(mock.lastPrompt).not.toContain("Beta");
  });

  it("rejection feedback on a client's task is remembered for that client only", async () => {
    const w = await world();
    const a = await makeApproval(w.ws.id, w.taskA.id, w.emp.id, { status: "REJECTED", feedback: "Use the Alpha letterhead." });
    await handleRejection(a.id);
    const [m] = await db.select().from(memories).where(and(eq(memories.employeeId, w.emp.id), eq(memories.source, "rejection")));
    expect(m!.clientId).toBe(w.a.id);
    expect((await db.select().from(approvals).where(eq(approvals.id, a.id)))[0]!.status).toBe("REJECTED");
  });

  it("the nightly tidy never merges memories across clients", async () => {
    const w = await world();
    await db.insert(memories).values([
      { workspaceId: w.ws.id, employeeId: w.emp.id, clientId: w.a.id, content: "Prefers email over calls.", embedding: vec },
      { workspaceId: w.ws.id, employeeId: w.emp.id, clientId: w.b.id, content: "Prefers email over calls.", embedding: vec },
    ]);
    await tidyEmployeeMemories(w.emp.id);
    const rows = await db.select().from(memories).where(and(eq(memories.employeeId, w.emp.id), eq(memories.content, "Prefers email over calls.")));
    expect(rows.every((r) => r.supersededBy === null)).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, w.taskA.id))).length).toBe(1);
  });
});
