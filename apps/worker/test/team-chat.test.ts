import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, db, employees, messages, steps, teamMembers, teams, workspaces } from "@wfos/db";
import { ROUTING_MODEL, type AutoActionChip, type EmployeeStatus, type MessageMeta, type TeamResponderMode } from "@wfos/shared";
import type { AgentRunInput } from "../src/runner/executor";
import { runChat, TEAM_LEASE_RETRY } from "../src/runner/chat";
import { MAX_RESPONDERS_PER_TURN } from "../src/runner/responders";
import { ROUTING_MESSAGE_CHARS } from "../src/runner/route-classifier";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { acquireEmployeeLease, releaseEmployeeLease } from "../src/guards/lease";
import { makeWorkspace, sendUserMessage } from "./fixtures";
import { resetTransport, transport } from "./transport";

// Capture every chat RunContext (and let a test add allow-listed auto actions) without touching the executor.
// `taint`: employee ids whose run reads injected content; `startTainted`: each run's taint when it started.
const runs = vi.hoisted(() => ({ inputs: [] as AgentRunInput[], chips: [] as AutoActionChip[], taint: new Set<string>(), startTainted: [] as boolean[] }));
vi.mock("../src/runner/executor", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/runner/executor")>();
  return {
    ...real,
    runAgent: async (input: AgentRunInput) => {
      runs.inputs.push(input);
      runs.startTainted.push(input.ctx.guard.tainted);
      const out = await real.runAgent(input);
      if (runs.taint.has(input.ctx.employee.id)) input.ctx.guard.tainted = true;
      for (const c of runs.chips) input.ctx.autoActions?.push(c);
      return out;
    },
  };
});

// Let a test hold up the routing classifier's credential lookup (only for workspaces in `slow`).
const cred = vi.hoisted(() => ({ slow: new Set<string>(), delayMs: 0 }));
vi.mock("@wfos/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/db")>();
  return {
    ...real,
    resolveClaudeCredential: async (workspaceId: string) => {
      if (cred.slow.has(workspaceId)) await new Promise((r) => setTimeout(r, cred.delayMs));
      return real.resolveClaudeCredential(workspaceId);
    },
  };
});

interface SdkCall {
  model: string;
  prompt: string;
  systemPrompt: string;
  options: NonNullable<Parameters<QueryFn>[0]["options"]>;
}

/**
 * One scripted SDK for the whole turn: the routing classifier (ROUTING_MODEL) gets `router`, every
 * employee run replies "Reply from <name>" (the name is read from its system prompt).
 */
function scriptSdk(router: MockStep[] = []) {
  const calls: SdkCall[] = [];
  const query = ((p: Parameters<QueryFn>[0]) => {
    const options = p.options ?? {};
    const systemPrompt = String(options.systemPrompt ?? "");
    calls.push({ model: String(options.model), prompt: String(p.prompt), systemPrompt, options });
    if (options.model === ROUTING_MODEL) return mockRunner(router).query(p);
    const name = /^You are ([^,]+),/.exec(systemPrompt)?.[1] ?? "?";
    const text = `Reply from ${name}`;
    return mockRunner([{ llm: { input: 10, output: 10, text } }, { result: text }]).query(p);
  }) as QueryFn;
  setQueryImpl(query);
  return {
    calls,
    replies: () => calls.filter((c) => c.model !== ROUTING_MODEL),
    routing: () => calls.filter((c) => c.model === ROUTING_MODEL),
  };
}

const routerSays = (text: string): MockStep[] => [{ llm: { input: 120, output: 12, text, model: ROUTING_MODEL } }, { result: text }];

type Emp = typeof employees.$inferSelect;

async function makeTeamChat(opts: { mode?: TeamResponderMode; members: { name: string; role: string; status?: EmployeeStatus }[]; lead?: number | null }) {
  const ws = await makeWorkspace();
  const emps: Emp[] = [];
  for (const m of opts.members) {
    const [e] = await db
      .insert(employees)
      .values({ workspaceId: ws.id, name: m.name, role: m.role, model: "claude-sonnet-5-5", autonomyLevel: "EXECUTE", dailyBudget: 200, status: m.status ?? "ACTIVE" })
      .returning();
    emps.push(e!);
  }
  const leadIdx = opts.lead === undefined ? 0 : opts.lead;
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws.id, name: "Ops", leadId: leadIdx === null ? null : emps[leadIdx]!.id, responderMode: opts.mode ?? "lead" })
    .returning();
  if (emps.length) await db.insert(teamMembers).values(emps.map((e) => ({ teamId: team!.id, employeeId: e.id })));
  const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, teamId: team!.id }).returning();
  return { ws, emps, team: team!, conv: conv! };
}

async function userMessage(conversationId: string, content: string, meta: MessageMeta = {}) {
  return sendUserMessage(conversationId, { content, meta });
}

const rows = (conversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id));
const replyRows = async (conversationId: string) => (await rows(conversationId)).filter((m) => m.role === "assistant");

beforeEach(() => {
  resetTransport();
  runs.inputs.length = 0;
  runs.chips.length = 0;
  runs.taint.clear();
  runs.startTainted.length = 0;
});
afterEach(() => setQueryImpl(null));

describe("team chat routing", () => {
  it("a mention routes to the mentioned members only, in team order", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "lead", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }, { name: "Dewi", role: "Sales" }] });
    const [budi, sari, dewi] = emps;
    const m = await userMessage(conv.id, "@Dewi @Sari can you check the invoice?", { mentions: [dewi!.id, sari!.id] });
    const sdk = scriptSdk();

    await runChat(conv.id, m.id);

    const replies = await replyRows(conv.id);
    expect(replies.map((r) => r.employeeId)).toEqual([sari!.id, dewi!.id]);
    expect(replies.map((r) => r.content)).toEqual(["Reply from Sari", "Reply from Dewi"]);
    expect(replies.every((r) => r.status === "done")).toBe(true);
    for (const r of replies) expect(r.meta).toEqual({ turnMessageIds: [m.id], routedBy: { mode: "mention" } });
    expect(sdk.routing()).toHaveLength(0);
    expect(replies.some((r) => r.employeeId === budi!.id)).toBe(false);
  });

  it("@semua: everyone answers in turn, lead first; later responders see the earlier replies", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "lead", members: [{ name: "Sari", role: "Finance" }, { name: "Budi", role: "Lead" }], lead: 1 });
    const [sari, budi] = emps;
    // earlier history: a reply by Sari must be labelled with her name, not the current responder's
    await db.insert(messages).values({ conversationId: conv.id, role: "user", content: "Earlier question", handledAt: new Date(Date.now() - 5000), createdAt: new Date(Date.now() - 5000) });
    await db.insert(messages).values({ conversationId: conv.id, role: "assistant", content: "Earlier answer", employeeId: sari!.id, status: "done", createdAt: new Date(Date.now() - 4000) });
    const m = await userMessage(conv.id, "@semua status update please", { mentionAll: true });
    const sdk = scriptSdk();

    await runChat(conv.id, m.id);

    const replies = (await replyRows(conv.id)).slice(1);
    expect(replies.map((r) => r.employeeId)).toEqual([budi!.id, sari!.id]);
    for (const r of replies) expect(r.meta).toEqual({ turnMessageIds: [m.id], routedBy: { mode: "everyone" } });
    const [first, second] = sdk.replies();
    expect(first!.prompt).toContain("Sari: Earlier answer");
    expect(first!.prompt).not.toContain("Reply from");
    expect(second!.prompt).toContain("Budi: Reply from Budi");
    expect(second!.prompt.indexOf("status update please")).toBeLessThan(second!.prompt.indexOf("Budi: Reply from Budi"));
    // team chat context in the system prompt
    expect(first!.systemPrompt).toContain("team chat of Ops");
    expect(first!.systemPrompt).toContain("Sari — Finance");
    expect(first!.systemPrompt).toMatch(/lead is Budi/);
  });

  it("mode lead: the lead answers an un-mentioned message", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "lead", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const m = await userMessage(conv.id, "Who is on call?");
    scriptSdk();
    await runChat(conv.id, m.id);
    const replies = await replyRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.employeeId).toBe(emps[0]!.id);
    expect(replies[0]!.meta).toEqual({ turnMessageIds: [m.id], routedBy: { mode: "lead" } });
  });

  it("mode everyone without a mention: all active members answer", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "everyone", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const m = await userMessage(conv.id, "Morning all");
    scriptSdk();
    await runChat(conv.id, m.id);
    expect((await replyRows(conv.id)).map((r) => r.employeeId)).toEqual([emps[0]!.id, emps[1]!.id]);
  });

  it("mode mentions without a mention: a hint system message and no run", async () => {
    const { conv, ws } = await makeTeamChat({ mode: "mentions", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const m = await userMessage(conv.id, "Anyone?");
    const sdk = scriptSdk();

    await runChat(conv.id, m.id);
    await runChat(conv.id, m.id); // a retry finds nothing to claim

    expect(sdk.calls).toHaveLength(0);
    const all = await rows(conv.id);
    expect(all.filter((r) => r.role === "assistant")).toHaveLength(0);
    const hints = all.filter((r) => r.role === "system");
    expect(hints).toHaveLength(1);
    expect(hints[0]!.meta).toEqual({ hint: "no_responder" });
    expect(all.find((r) => r.id === m.id)!.handledAt).toBeInstanceOf(Date);
    const pub = transport.published.find((p) => (p.ev as { type: string; message?: { id: string } }).message?.id === hints[0]!.id);
    expect(pub?.workspaceId).toBe(ws.id);
  });

  it("mode mentions with a mention routes to the mentioned member", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "mentions", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const m = await userMessage(conv.id, "@Sari ?", { mentions: [emps[1]!.id] });
    scriptSdk();
    await runChat(conv.id, m.id);
    expect((await replyRows(conv.id)).map((r) => r.employeeId)).toEqual([emps[1]!.id]);
  });

  it("mode auto: the classifier's pick answers; confidence is recorded and the step carries no message text", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }, { name: "Dewi", role: "Sales" }] });
    const sari = emps[1]!;
    const m = await userMessage(conv.id, "Please reconcile the March invoices SECRET-TEXT-42");
    const sdk = scriptSdk(routerSays(`Sure: {"pick":"${sari.id}","confidence":0.92}`));

    await runChat(conv.id, m.id);

    const replies = await replyRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.employeeId).toBe(sari.id);
    expect(replies[0]!.content).toBe("Reply from Sari");
    expect(replies[0]!.meta).toEqual({ turnMessageIds: [m.id], routedBy: { mode: "auto", confidence: 0.92 } });

    const [route] = sdk.routing();
    expect(route).toBeDefined();
    expect(route!.prompt).toContain(sari.id);
    expect(route!.prompt).toContain("SECRET-TEXT-42");
    expect(route!.options.maxTurns).toBe(1);
    expect(route!.options.mcpServers ?? {}).toEqual({});
    expect(route!.options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "WebFetch", "Task"]));
    expect(route!.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("stub-token-never-sent");

    const decisions = await db.select().from(steps).where(and(eq(steps.conversationId, conv.id), eq(steps.name, "route_decision")));
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.kind).toBe("system");
    expect(d.model).toBe(ROUTING_MODEL);
    expect(d.inputTokens).toBe(120);
    expect(d.outputTokens).toBe(12);
    expect(d.credits).toBeGreaterThan(0);
    expect(d.input).toEqual({ mode: "auto" });
    expect(d.output).toEqual({ pick: sari.id, confidence: 0.92 });
    expect(JSON.stringify(d)).not.toContain("SECRET-TEXT-42");
  });

  it("mode auto: __everyone__ makes all active members answer", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const m = await userMessage(conv.id, "Hi team");
    scriptSdk(routerSays(`{"pick":"__everyone__","confidence":0.8}`));
    await runChat(conv.id, m.id);
    const replies = await replyRows(conv.id);
    expect(replies.map((r) => r.employeeId)).toEqual([emps[0]!.id, emps[1]!.id]);
    expect(replies[1]!.meta).toEqual({ turnMessageIds: [m.id], routedBy: { mode: "auto", confidence: 0.8 } });
  });

  const fallbacks: [string, MockStep[], string][] = [
    ["a timeout", [{ wait: 8000 }, ...routerSays(`{"pick":"x","confidence":1}`)], "timeout"],
    ["invalid JSON", routerSays("I think Sari should answer."), "invalid"],
    ["an unknown id", routerSays(`{"pick":"00000000-0000-0000-0000-000000000000","confidence":0.99}`), "invalid"],
    ["low confidence", routerSays(`{"pick":"SARI","confidence":0.3}`), "low_confidence"],
  ];
  for (const [label, router, reason] of fallbacks) {
    it(`mode auto: ${label} falls back to the lead (${reason})`, async () => {
      const { conv, emps } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
      const m = await userMessage(conv.id, "Something");
      const sari = (t: string) => t.replace("SARI", emps[1]!.id);
      const script = router.map((s): MockStep => ("llm" in s && s.llm.text ? { llm: { ...s.llm, text: sari(s.llm.text) } } : "result" in s ? { result: sari(s.result) } : s));
      scriptSdk(script);
      const t0 = Date.now();
      await runChat(conv.id, m.id);
      if (reason === "timeout") expect(Date.now() - t0).toBeLessThan(7500);
      const replies = await replyRows(conv.id);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.employeeId).toBe(emps[0]!.id);
      expect(replies[0]!.content).toBe("Reply from Budi");
      expect(replies[0]!.meta).toEqual({ turnMessageIds: [m.id], routedBy: { mode: "fallback", reason } });
      const [d] = await db.select().from(steps).where(and(eq(steps.conversationId, conv.id), eq(steps.name, "route_decision")));
      expect(d!.output).toMatchObject({ reason });
    });
  }

  it("mode auto: a timeout that fires before the query starts never calls the model (fallback timeout)", async () => {
    const { conv, ws, emps } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    cred.slow.add(ws.id);
    cred.delayMs = 5300;
    try {
      const m = await userMessage(conv.id, "Something");
      const sdk = scriptSdk(routerSays(`{"pick":"${emps[1]!.id}","confidence":1}`));
      await runChat(conv.id, m.id);
      expect(sdk.routing()).toHaveLength(0);
      const replies = await replyRows(conv.id);
      expect(replies.map((r) => r.employeeId)).toEqual([emps[0]!.id]);
      expect(replies[0]!.meta.routedBy).toEqual({ mode: "fallback", reason: "timeout" });
    } finally {
      cred.slow.clear();
    }
  });

  it("mode auto with the kill switch engaged: no classifier call", async () => {
    const { conv, ws } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const { workspaces } = await import("@wfos/db");
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, ws.id));
    const m = await userMessage(conv.id, "Hello");
    const sdk = scriptSdk(routerSays(`{"pick":"__everyone__","confidence":1}`));
    await runChat(conv.id, m.id);
    expect(sdk.calls).toHaveLength(0);
    const replies = await replyRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.status).toBe("error");
  });

  it("inactive members are skipped; an inactive lead hands over to the first active member", async () => {
    const { conv, emps } = await makeTeamChat({
      mode: "everyone",
      members: [{ name: "Budi", role: "Lead", status: "PAUSED" }, { name: "Sari", role: "Finance", status: "ARCHIVED" }, { name: "Dewi", role: "Sales" }, { name: "Eka", role: "Ops" }],
    });
    const m = await userMessage(conv.id, "Status?");
    scriptSdk();
    await runChat(conv.id, m.id);
    expect((await replyRows(conv.id)).map((r) => r.employeeId)).toEqual([emps[2]!.id, emps[3]!.id]);

    // mode lead with the lead paused → the first active member answers
    await db.update(teams).set({ responderMode: "lead" }).where(eq(teams.id, (await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0]!.teamId!));
    const m2 = await userMessage(conv.id, "And now?");
    await runChat(conv.id, m2.id);
    const last = (await replyRows(conv.id)).at(-1)!;
    expect(last.employeeId).toBe(emps[2]!.id);
    expect(last.meta.routedBy).toEqual({ mode: "fallback", reason: "lead_unavailable" });
  });

  it("a busy responder is skipped with a short system note", async () => {
    const prev = structuredClone(TEAM_LEASE_RETRY);
    TEAM_LEASE_RETRY.implicit = { attempts: 2, delayMs: 10 };
    try {
      const { conv, emps } = await makeTeamChat({ mode: "everyone", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }, { name: "Dewi", role: "Sales" }] });
      expect(await acquireEmployeeLease(emps[1]!.id, "other-job", 1)).toBe(true);
      const m = await userMessage(conv.id, "Status?");
      scriptSdk();
      await runChat(conv.id, m.id);
      const all = (await rows(conv.id)).filter((r) => r.id !== m.id);
      expect(all.map((r) => [r.role, r.employeeId])).toEqual([
        ["assistant", emps[0]!.id],
        ["system", emps[1]!.id],
        ["assistant", emps[2]!.id],
      ]);
      expect(all[1]!.content).toContain("Sari is busy");
      expect(all[1]!.meta).toEqual({ turnMessageIds: [m.id], hint: "busy" });
    } finally {
      Object.assign(TEAM_LEASE_RETRY, prev);
    }
  });

  it("a busy first responder turns the opening row into the busy note (hint, employee set)", async () => {
    const prev = structuredClone(TEAM_LEASE_RETRY);
    TEAM_LEASE_RETRY.mentioned = { attempts: 1, delayMs: 0 };
    try {
      const { conv, emps } = await makeTeamChat({ mode: "lead", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
      expect(await acquireEmployeeLease(emps[1]!.id, "other-job", 1)).toBe(true);
      const m = await userMessage(conv.id, "@Sari ?", { mentions: [emps[1]!.id] });
      scriptSdk();
      await runChat(conv.id, m.id);
      const all = (await rows(conv.id)).filter((r) => r.id !== m.id);
      expect(all).toHaveLength(1);
      expect(all[0]!.role).toBe("system");
      expect(all[0]!.employeeId).toBe(emps[1]!.id);
      expect(all[0]!.meta).toEqual({ turnMessageIds: [m.id], hint: "busy" });
      expect(all[0]!.content).toBe("Sari is busy with other work right now and could not reply.");
    } finally {
      Object.assign(TEAM_LEASE_RETRY, prev);
    }
  });

  it("an @mentioned member is waited for longer than an implicit responder", async () => {
    const prev = structuredClone(TEAM_LEASE_RETRY);
    TEAM_LEASE_RETRY.mentioned = { attempts: 20, delayMs: 25 };
    TEAM_LEASE_RETRY.implicit = { attempts: 1, delayMs: 0 };
    try {
      const { conv, emps } = await makeTeamChat({ mode: "everyone", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
      const sari = emps[1]!;
      // implicit (mode everyone): one attempt, Sari is busy → note
      expect(await acquireEmployeeLease(sari.id, "other-job", 1)).toBe(true);
      const m1 = await userMessage(conv.id, "Status?");
      scriptSdk();
      await runChat(conv.id, m1.id);
      expect((await rows(conv.id)).filter((r) => r.role === "system").map((r) => r.meta.hint)).toEqual(["busy"]);

      // mentioned: her other job ends while we wait → she answers
      const m2 = await userMessage(conv.id, "@Sari status?", { mentions: [sari.id] });
      setTimeout(() => void releaseEmployeeLease(sari.id, "other-job"), 150);
      await runChat(conv.id, m2.id);
      const last = (await rows(conv.id)).at(-1)!;
      expect(last.role).toBe("assistant");
      expect(last.employeeId).toBe(sari.id);
      expect(last.content).toBe("Reply from Sari");
    } finally {
      Object.assign(TEAM_LEASE_RETRY, prev);
    }
  });

  it(`at most ${MAX_RESPONDERS_PER_TURN} members answer one turn, lead first; the rest are noted on the last reply`, async () => {
    const names = ["Ana", "Budi", "Citra", "Dewi", "Eka", "Fajar", "Gita"];
    const { conv, emps } = await makeTeamChat({ mode: "lead", members: names.map((n) => ({ name: n, role: "Staff" })), lead: 1 });
    const m = await userMessage(conv.id, "@semua roll call", { mentionAll: true });
    scriptSdk();
    await runChat(conv.id, m.id);
    const replies = await replyRows(conv.id);
    const ordered = [emps[1]!, ...emps.filter((_, i) => i !== 1)];
    expect(replies.map((r) => r.employeeId)).toEqual(ordered.slice(0, MAX_RESPONDERS_PER_TURN).map((e) => e.id));
    const skipped = ordered.slice(MAX_RESPONDERS_PER_TURN).map((e) => e.id);
    expect(replies.at(-1)!.meta.skippedResponders).toEqual(skipped);
    expect(replies.slice(0, -1).every((r) => r.meta.skippedResponders === undefined)).toBe(true);
    expect(replies.at(-1)!.meta.routedBy).toEqual({ mode: "everyone" });
  });

  it("many mentions are capped too", async () => {
    const names = ["Ana", "Budi", "Citra", "Dewi", "Eka", "Fajar"];
    const { conv, emps } = await makeTeamChat({ mode: "lead", members: names.map((n) => ({ name: n, role: "Staff" })), lead: 5 });
    const m = await userMessage(conv.id, "all of you", { mentions: emps.map((e) => e.id) });
    scriptSdk();
    await runChat(conv.id, m.id);
    const replies = await replyRows(conv.id);
    expect(replies).toHaveLength(MAX_RESPONDERS_PER_TURN);
    expect(replies[0]!.employeeId).toBe(emps[5]!.id);
    expect(replies.at(-1)!.meta.skippedResponders).toEqual([emps[4]!.id]);
  });

  it("once a responder read injected content, the later responders of the turn start tainted", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "everyone", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }, { name: "Dewi", role: "Sales" }] });
    runs.taint.add(emps[1]!.id);
    const m = await userMessage(conv.id, "Summarise the web page");
    scriptSdk();
    await runChat(conv.id, m.id);
    expect(runs.inputs.map((i) => i.ctx.employee.id)).toEqual(emps.map((e) => e.id));
    expect(runs.startTainted).toEqual([false, false, true]);

    // every reply of the tainted turn is marked untrusted (the one before the taint too)
    expect((await replyRows(conv.id)).map((r) => r.meta.untrusted)).toEqual([true, true, true]);

    // the next turn reads those replies in its transcript: it starts tainted too
    const m2 = await userMessage(conv.id, "Next");
    runs.taint.clear();
    runs.startTainted.length = 0;
    await runChat(conv.id, m2.id);
    expect(runs.startTainted).toEqual([true, true, true]);
  });

  it("mode auto while the workspace is paused on the subscription limit: no classifier call (fallback quota)", async () => {
    const { conv, ws, emps } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    await db.update(workspaces).set({ quotaPausedUntil: new Date(Date.now() + 3600_000), quotaPauseReason: "limit" }).where(eq(workspaces.id, ws.id));
    const m = await userMessage(conv.id, "Hello");
    const sdk = scriptSdk(routerSays(`{"pick":"__everyone__","confidence":1}`));
    await runChat(conv.id, m.id);
    expect(sdk.routing()).toHaveLength(0);
    const replies = await replyRows(conv.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.employeeId).toBe(emps[0]!.id);
    expect(replies[0]!.meta.routedBy).toEqual({ mode: "fallback", reason: "quota" });
  });

  it("the routing prompt carries at most the first 4000 chars of the new message", async () => {
    const { conv, emps } = await makeTeamChat({ mode: "auto", members: [{ name: "Budi", role: "Lead" }, { name: "Sari", role: "Finance" }] });
    const m = await userMessage(conv.id, `${"a".repeat(ROUTING_MESSAGE_CHARS)}TAIL-MARKER`);
    const sdk = scriptSdk(routerSays(`{"pick":"${emps[1]!.id}","confidence":0.9}`));
    await runChat(conv.id, m.id);
    const [route] = sdk.routing();
    expect(route!.prompt).toContain("a".repeat(ROUTING_MESSAGE_CHARS));
    expect(route!.prompt).not.toContain("TAIL-MARKER");
    // the responder still gets the whole message
    expect(sdk.replies()[0]!.prompt).toContain("TAIL-MARKER");
  });

  it("chat runs carry the assistant message id; allow-listed auto actions become chips; no approvals suffix", async () => {
    const { conv } = await makeTeamChat({ mode: "lead", members: [{ name: "Budi", role: "Lead" }] });
    const m = await userMessage(conv.id, "Send it");
    runs.chips.push({ tool: "send_email", label: "Email to client@example.co.id" });
    scriptSdk();
    await runChat(conv.id, m.id);
    const [reply] = await replyRows(conv.id);
    expect(runs.inputs).toHaveLength(1);
    expect(runs.inputs[0]!.ctx.messageId).toBe(reply!.id);
    expect(reply!.meta.chips).toEqual([{ tool: "send_email", label: "Email to client@example.co.id" }]);
    expect(reply!.content).toBe("Reply from Budi");
    expect(reply!.content).not.toContain("Approvals inbox");
  });
});
