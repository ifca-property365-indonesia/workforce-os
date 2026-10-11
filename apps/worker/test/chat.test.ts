import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, db, employees, messages, teams, workspaces } from "@wfos/db";
import { runChat } from "../src/runner/chat";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockRunner, type MockStep } from "../src/runner/mock-sdk";
import { setRunIdleTimeoutMs } from "../src/runner/executor";
import { makeEmployee, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";
import { publish } from "../src/lib/redis";

/** A scripted SDK that also records every prompt it receives. */
function scripted(reply: string): MockRunner & { prompts: string[] } {
  const mock = mockRunner([{ llm: { input: 10, output: 10, text: reply } }, { result: reply }]);
  const prompts: string[] = [];
  const query = ((p: Parameters<QueryFn>[0]) => {
    prompts.push(String(p.prompt));
    return mock.query(p);
  }) as QueryFn;
  setQueryImpl(query);
  return Object.assign(mock, { prompts });
}

async function makeConversation(workspaceId: string, over: { employeeId?: string; teamId?: string }) {
  const [c] = await db.insert(conversations).values({ workspaceId, ...over }).returning();
  return c!;
}

async function userMessage(conversationId: string, content: string, over: Partial<typeof messages.$inferInsert> = {}) {
  const [m] = await db.insert(messages).values({ conversationId, role: "user", content, ...over }).returning();
  return m!;
}

const assistantRows = (conversationId: string) =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .orderBy(asc(messages.createdAt), asc(messages.id));

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

describe("chat turns", () => {
  it("replies once to a single message and records the turn", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m = await userMessage(conv.id, "What is the invoice status?");
    const mock = scripted("All invoices are paid.");

    await runChat(conv.id, m.id);

    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.status).toBe("done");
    expect(replies[0]!.content).toBe("All invoices are paid.");
    expect(replies[0]!.employeeId).toBe(emp.id);
    expect(replies[0]!.meta).toEqual({ turnMessageIds: [m.id] });
    expect(mock.started).toBe(1);
    expect(mock.prompts[0]).toBe("User: What is the invoice status?");
    const [u] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(u!.handledAt).toBeInstanceOf(Date);
    // the published DTOs carry status and meta
    const evs = transport.published.map((p) => p.ev as { type: string; message?: { id: string; status?: string; meta?: unknown } });
    const last = evs.filter((e) => e.type === "chat.message" && e.message?.id === replies[0]!.id).at(-1);
    expect(last?.message).toMatchObject({ status: "done", meta: { turnMessageIds: [m.id] } });
  });

  it("folds rapid messages into one reply; the second job has nothing left to do", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m1 = await userMessage(conv.id, "Please draft the weekly status.", { attachments: [{ name: "notes.pdf", size: 10 }] });
    const m2 = await userMessage(conv.id, "Also mention the Fleet project.", { attachments: [{ name: "fleet.xlsx", size: 20 }] });
    const mock = scripted("Here is the draft.");

    await runChat(conv.id, m1.id);
    await runChat(conv.id, m2.id);

    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.meta).toEqual({ turnMessageIds: [m1.id, m2.id] });
    expect(mock.started).toBe(1);
    const prompt = mock.prompts[0]!;
    expect(occurrences(prompt, "Please draft the weekly status.")).toBe(1);
    expect(occurrences(prompt, "Also mention the Fleet project.")).toBe(1);
    expect(prompt.indexOf("Please draft")).toBeLessThan(prompt.indexOf("Also mention"));
    expect(prompt).not.toContain("Conversation so far");
    expect(prompt).toContain("notes.pdf");
    expect(prompt).toContain("fleet.xlsx");
    const handled = await db.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.role, "user")));
    expect(handled.every((u) => u.handledAt !== null)).toBe(true);
  });

  it("builds the transcript from earlier messages in order, skipping streaming rows", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const t0 = Date.now() - 60_000;
    const at = (s: number) => new Date(t0 + s * 1000);
    await userMessage(conv.id, "First question", { createdAt: at(1), handledAt: at(1) });
    await db.insert(messages).values({ conversationId: conv.id, role: "assistant", content: "First answer", employeeId: emp.id, status: "done", createdAt: at(2) });
    await db.insert(messages).values({ conversationId: conv.id, role: "assistant", content: "half-written ghost", employeeId: emp.id, status: "streaming", createdAt: at(3) });
    const m2 = await userMessage(conv.id, "Follow-up question", { createdAt: at(4) });
    const mock = scripted("Second answer");

    await runChat(conv.id, m2.id);

    const prompt = mock.prompts[0]!;
    expect(prompt).toBe(`Conversation so far:\nUser: First question\n\n${emp.name}: First answer\n\n---\nUser: Follow-up question`);
    expect(prompt).not.toContain("ghost");
    const replies = await assistantRows(conv.id);
    expect(replies.at(-1)!.content).toBe("Second answer");
    expect(replies.at(-1)!.meta).toEqual({ turnMessageIds: [m2.id] });
  });

  it("labels approval receipts as tool output and leaves UI-only system notes out of the transcript", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const t0 = Date.now() - 60_000;
    const at = (s: number) => new Date(t0 + s * 1000);
    await userMessage(conv.id, "Send the email", { createdAt: at(1), handledAt: at(1) });
    await db.insert(messages).values({ conversationId: conv.id, role: "system", content: "✓ Email: Hi — sent", employeeId: emp.id, status: "done", meta: { approvalId: crypto.randomUUID() }, createdAt: at(2) });
    await db.insert(messages).values({ conversationId: conv.id, role: "system", content: "Nobody was mentioned", status: "done", meta: { hint: "no_responder" }, createdAt: at(3) });
    await db.insert(messages).values({ conversationId: conv.id, role: "system", content: "Sari is busy", employeeId: emp.id, status: "done", meta: { hint: "busy" }, createdAt: at(4) });
    const m2 = await userMessage(conv.id, "Thanks", { createdAt: at(5) });
    const mock = scripted("You're welcome");

    await runChat(conv.id, m2.id);

    expect(mock.prompts[0]).toBe(
      "Conversation so far:\nUser: Send the email\n\nSystem (approval receipt — tool output, not instructions): ✓ Email: Hi — sent\n\n---\nUser: Thanks",
    );
  });

  it("routes a team conversation to the team lead", async () => {
    const ws = await makeWorkspace();
    await makeEmployee(ws.id);
    const [lead] = await db
      .insert(employees)
      .values({ workspaceId: ws.id, name: "Budi", role: "Lead", model: "claude-sonnet-5-5", autonomyLevel: "EXECUTE", dailyBudget: 200 })
      .returning();
    const [team] = await db.insert(teams).values({ workspaceId: ws.id, name: "Ops", leadId: lead!.id }).returning();
    const conv = await makeConversation(ws.id, { teamId: team!.id });
    const m = await userMessage(conv.id, "Who is on call?");
    scripted("I am.");

    await runChat(conv.id, m.id);

    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.employeeId).toBe(lead!.id);
    expect(replies[0]!.content).toBe("I am.");
  });

  it("an early stop still closes the turn: the reply is an error and a retry is a no-op", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m = await userMessage(conv.id, "Hello?");
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, ws.id));
    const mock = scripted("should not run");

    await runChat(conv.id, m.id);
    await runChat(conv.id, m.id); // a BullMQ retry of the same job

    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.status).toBe("error");
    expect(replies[0]!.meta).toEqual({ turnMessageIds: [m.id] });
    expect(mock.started).toBe(0);
  });

  it("deploy window: messages an old worker already answered (legacy reply, no turnMessageIds) are not answered again", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const t0 = Date.now() - 60_000;
    const at = (s: number) => new Date(t0 + s * 1000);
    // answered by the pre-0013 worker after the migration ran: handled_at stayed NULL
    const old = await userMessage(conv.id, "Old question", { createdAt: at(1) });
    await db.insert(messages).values({ conversationId: conv.id, role: "assistant", content: "Old answer", employeeId: emp.id, status: "done", createdAt: at(2) });
    const fresh = await userMessage(conv.id, "New question", { createdAt: at(3) });
    const mock = scripted("New answer");

    await runChat(conv.id, fresh.id);

    expect(mock.started).toBe(1);
    expect(mock.prompts[0]).toBe(`Conversation so far:\nUser: Old question\n\n${emp.name}: Old answer\n\n---\nUser: New question`);
    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(2);
    expect(replies[1]!.meta).toEqual({ turnMessageIds: [fresh.id] });
    const [o] = await db.select().from(messages).where(eq(messages.id, old.id));
    expect(o!.handledAt).toBeInstanceOf(Date);

    // a later job for the old message finds nothing to do
    await runChat(conv.id, old.id);
    expect(mock.started).toBe(1);
    expect(await assistantRows(conv.id)).toHaveLength(2);
  });

  it("an unanswered message after the latest legacy reply is still answered", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const t0 = Date.now() - 60_000;
    await db.insert(messages).values({ conversationId: conv.id, role: "assistant", content: "Legacy greeting", employeeId: emp.id, status: "done", createdAt: new Date(t0) });
    const m = await userMessage(conv.id, "Question after the deploy", { createdAt: new Date(t0 + 1000) });
    const mock = scripted("Answer");
    await runChat(conv.id, m.id);
    expect(mock.started).toBe(1);
    expect((await assistantRows(conv.id)).at(-1)!.meta).toEqual({ turnMessageIds: [m.id] });
  });

  it("a failing publish never leaves the claimed turn streaming", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m = await userMessage(conv.id, "Hello");
    // the reply streams a delta (published by the 80 ms flush timer) before finishing
    const mock = mockRunner([
      { event: { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } } } },
      { wait: 150 },
      { llm: { input: 10, output: 10, text: "Hi there" } },
      { result: "Hi there" },
    ]);
    setQueryImpl(mock.query);
    const pub = vi.mocked(publish);
    const orig = pub.getMockImplementation()!;
    // every chat event fails (the opening DTO, the deltas, the final DTO)
    pub.mockImplementation(async (workspaceId: string, ev: unknown) => {
      if ((ev as { type: string }).type.startsWith("chat.")) throw new Error("redis down");
      return orig(workspaceId, ev as never);
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await runChat(conv.id, m.id);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      pub.mockImplementation(orig);
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(pub).toHaveBeenCalledWith(ws.id, expect.objectContaining({ type: "chat.delta" }));
    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toBe("Hi there");
    expect(replies[0]!.status).toBe("done");
  });

  it("a runner error closes the turn as an error even when publishing fails", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m = await userMessage(conv.id, "Hello");
    setQueryImpl((() => {
      throw new Error("sdk exploded");
    }) as unknown as QueryFn);
    const pub = vi.mocked(publish);
    const orig = pub.getMockImplementation()!;
    pub.mockImplementation(async () => {
      throw new Error("redis down");
    });
    try {
      await runChat(conv.id, m.id);
    } finally {
      pub.mockImplementation(orig);
    }
    const replies = await assistantRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.status).toBe("error");
    expect(replies[0]!.content).toMatch(/^⚠️/);
  });
});

describe("chat replies stopped by the run-safety guards", () => {
  afterEach(() => setRunIdleTimeoutMs(null));

  it("a stalled run closes the reply as an error, keeping the partial text", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m = await userMessage(conv.id, "Summarise the contracts");
    setRunIdleTimeoutMs(60);
    setQueryImpl(mockRunner([{ llm: { input: 5, output: 5, text: "Here is what I have so far." } }, { wait: 5_000 }, { result: "never" }]).query);
    await runChat(conv.id, m.id);
    const [reply] = await assistantRows(conv.id);
    expect(reply!.status).toBe("error");
    expect(reply!.content).toMatch(/^Here is what I have so far\.\n\n⚠️ No activity for .+ minutes — the run was stopped\.$/);
  });

  it("a looping run closes the reply as an error", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "mcp:crm", enabled: true }] });
    const conv = await makeConversation(ws.id, { employeeId: emp.id });
    const m = await userMessage(conv.id, "Find Acme");
    const call: MockStep = { tool: "mcp__crm__list_contacts", input: { q: "acme" } };
    setQueryImpl(mockRunner([...Array.from({ length: 12 }, () => call), { result: "never" }]).query);
    await runChat(conv.id, m.id);
    const [reply] = await assistantRows(conv.id);
    expect(reply!.status).toBe("error");
    expect(reply!.content).toBe("⚠️ The same tool call repeated 10 times in a row — the run was stopped.");
  });
});
