import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, db, employees, messages, steps } from "@wfos/db";
import type { EmployeeStatus, ToolPermission } from "@wfos/shared";
import { MAX_CONSULTS_PER_TURN, runChat } from "../src/runner/chat";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { grantedToolNames } from "../src/tools/registry";
import { makeWorkspace, runContext, sendUserMessage } from "./fixtures";
import { resetTransport } from "./transport";

type Emp = typeof employees.$inferSelect;

async function person(workspaceId: string, name: string, role: string, opts: { tools?: ToolPermission[]; status?: EmployeeStatus } = {}): Promise<Emp> {
  const [e] = await db
    .insert(employees)
    .values({
      workspaceId,
      name,
      role,
      model: "claude-sonnet-5-5",
      autonomyLevel: "EXECUTE",
      dailyBudget: 200,
      toolPermissions: opts.tools ?? [],
      status: opts.status ?? "ACTIVE",
    })
    .returning();
  return e!;
}

/** Each employee's run follows its own script (picked by the name in its system prompt); prompts are recorded. */
function scriptByName(scripts: Record<string, MockStep[]>) {
  const calls: { name: string; prompt: string; systemPrompt: string }[] = [];
  const query = ((p: Parameters<QueryFn>[0]) => {
    const systemPrompt = String(p.options?.systemPrompt ?? "");
    const name = /^You are ([^,]+),/.exec(systemPrompt)?.[1] ?? "?";
    calls.push({ name, prompt: String(p.prompt), systemPrompt });
    return mockRunner(scripts[name] ?? says(`Reply from ${name}`)).query(p);
  }) as QueryFn;
  setQueryImpl(query);
  return calls;
}

const ask = (employeeId: string, request: string): MockStep => ({ tool: "mcp__wfos__ask_teammate", input: { employeeId, request } });
function says(text: string): MockStep[] {
  return [{ llm: { input: 10, output: 10, text } }, { result: text }];
}

const replies = (conversationId: string) =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .orderBy(asc(messages.createdAt), asc(messages.id));

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

describe("ask_teammate in chat", () => {
  it("brings a colleague into a 1:1 chat: they reply right after, see the request, and the hand-off is recorded", async () => {
    const ws = await makeWorkspace();
    const dony = await person(ws.id, "Dony", "Developer");
    const pratama = await person(ws.id, "Pratama", "Project Manager", { tools: [{ tool: "send_email", enabled: true }] });
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: dony.id }).returning();
    const m = await sendUserMessage(conv!.id, { content: "Please email the client the release notes" });
    const calls = scriptByName({
      Dony: [ask(pratama.id, "Send the release notes to the client; I cannot send email."), ...says("I don't have email access, so I asked Pratama.")],
      Pratama: says("Pratama here: I'll draft that email for your approval."),
    });

    await runChat(conv!.id, m.id);

    const rows = await replies(conv!.id);
    expect(rows.map((r) => [r.employeeId, r.content])).toEqual([
      [dony.id, "I don't have email access, so I asked Pratama."],
      [pratama.id, "Pratama here: I'll draft that email for your approval."],
    ]);
    expect(rows[1]!.meta.askedBy).toBe(dony.id);
    expect(rows[1]!.parentId).toBe(rows[0]!.id);

    // Dony knew whom to ask and the honesty rule; Pratama got the request and Dony's reply
    const donyRun = calls.find((c) => c.name === "Dony")!;
    expect(donyRun.systemPrompt).toContain(`- Pratama (Project Manager) id=${pratama.id} · can: send_email`);
    expect(donyRun.systemPrompt).toContain("Only say you did something");
    expect(donyRun.systemPrompt).toContain("call ask_teammate");
    const pratamaRun = calls.find((c) => c.name === "Pratama")!;
    expect(pratamaRun.prompt).toContain("Dony brought you into this chat and asked: Send the release notes to the client; I cannot send email.");
    expect(pratamaRun.prompt).toContain("Dony: I don't have email access, so I asked Pratama.");

    const handoff = await db.select().from(steps).where(and(eq(steps.conversationId, conv!.id), eq(steps.kind, "agent_message")));
    expect(handoff.map((s) => [s.employeeId, s.name])).toEqual([[dony.id, "Dony → Pratama"]]);
  });

  it(`stops the chain after ${MAX_CONSULTS_PER_TURN} colleagues per turn`, async () => {
    const ws = await makeWorkspace();
    const a = await person(ws.id, "Ana", "Lead");
    const b = await person(ws.id, "Bima", "Dev");
    const c = await person(ws.id, "Citra", "QA");
    const d = await person(ws.id, "Dewi", "Sales");
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: a.id }).returning();
    const m = await sendUserMessage(conv!.id, { content: "Who can help?" });
    scriptByName({
      Ana: [ask(b.id, "help"), ...says("Asked Bima.")],
      Bima: [ask(c.id, "help"), ...says("Asked Citra.")],
      Citra: [ask(d.id, "help"), ...says("Asked Dewi.")],
    });

    await runChat(conv!.id, m.id);

    expect((await replies(conv!.id)).map((r) => r.employeeId)).toEqual([a.id, b.id, c.id]);
  });

  it("refuses inactive and unknown colleagues and yourself; never offered outside a chat", async () => {
    const ws = await makeWorkspace();
    const dony = await person(ws.id, "Dony", "Developer");
    const paused = await person(ws.id, "Sari", "Finance", { status: "PAUSED" });
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: dony.id }).returning();
    const m = await sendUserMessage(conv!.id, { content: "Get Sari to help" });
    const mock = mockRunner([ask(paused.id, "help"), ask(dony.id, "help"), ask("00000000-0000-4000-8000-000000000000", "help"), ...says("Nobody is available.")]);
    setQueryImpl(((p: Parameters<QueryFn>[0]) => mock.query(p)) as QueryFn);

    await runChat(conv!.id, m.id);

    const outputs = mock.calls.map((c) => c.output);
    expect(outputs[0]).toMatch(/Sari is paused/);
    expect(outputs[1]).toMatch(/cannot ask yourself/);
    expect(outputs[2]).toMatch(/Unknown employee/);
    expect((await replies(conv!.id)).map((r) => r.employeeId)).toEqual([dony.id]);

    const inTask = runContext(ws, dony, "00000000-0000-4000-8000-000000000001");
    expect(grantedToolNames(inTask).some((n) => n.endsWith("__ask_teammate"))).toBe(false);
    const inChat = runContext(ws, dony, null, { conversationId: conv!.id });
    expect(grantedToolNames(inChat).some((n) => n.endsWith("__ask_teammate"))).toBe(true);
  });
});
