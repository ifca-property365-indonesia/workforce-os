import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, db, employees, steps, tasks, teams } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl, setWorkspaceQueryFactory, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { SUBAGENT_TOOLS, subagentKey } from "../src/runner/division";
import { acquireRunLeases } from "../src/runner/run-lease";
import { divisionLeaseKey, employeeLeaseKey } from "../src/guards/lease";
import { redis } from "../src/lib/redis";
import { recordStep } from "../src/lib/steps";
import { makeDivision, makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => {
  setQueryImpl(null);
  setWorkspaceQueryFactory(null);
});

const SOP = { en: "1. Read the brief. 2. Ship small.", id: "1. Baca brief. 2. Kirim kecil." };

async function employee(workspaceId: string, values: Partial<typeof employees.$inferInsert>) {
  const e = await makeEmployee(workspaceId, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const [row] = await db.update(employees).set(values).where(eq(employees.id, e.id)).returning();
  return row!;
}

/** Delivery: head Pratiwi, code lead Arif (Workspace mode), member Kirana, subagents Citra and Bima. */
async function squad() {
  const ws = await makeWorkspace();
  const pm = await employee(ws.id, { name: "Pratiwi", role: "Project Manager" });
  const arif = await employee(ws.id, { name: "Arif", role: "Tech Lead", executionMode: "workspace", specialty: "Architecture and review" });
  const kirana = await employee(ws.id, { name: "Kirana", role: "UI/UX Designer", specialty: "Flows and prototypes" });
  const citra = await employee(ws.id, {
    name: "Citra",
    role: "Frontend Developer",
    specialty: "React UI",
    persona: "A careful frontend engineer.",
    instructions: "Use the design system components.",
    model: "claude-sonnet-5-5",
    outputLanguage: "id",
  });
  const bima = await employee(ws.id, { name: "Bima", role: "Backend Developer", specialty: "APIs and databases", model: "claude-haiku-5-5" });
  const division = await makeDivision(ws.id, {
    name: "Delivery",
    key: "delivery",
    head: pm,
    codeLead: arif,
    sop: SOP,
    members: [{ emp: kirana }, { emp: citra, role: "subagent" }, { emp: bima, role: "subagent" }],
  });
  return { ws, pm, arif, kirana, citra, bima, division };
}

const limitsNotices = () => transport.queued.filter((q) => q.queue === "misc" && (q.data as { notificationKind?: string }).notificationKind === "limits");

describe("division in the system prompt", () => {
  it("names the division, the employee's role and the SOP in the output language (Tool mode: no subagents)", async () => {
    const { ws, kirana } = await squad();
    await db.update(employees).set({ outputLanguage: "id" }).where(eq(employees.id, kirana.id));
    const mock = mockRunner([{ result: "ok" }]);
    setQueryImpl(mock.query);
    await runTask((await makeTask(ws.id, kirana.id)).id);
    const sp = String(mock.lastOptions!.systemPrompt);
    expect(sp).toContain("## Your division: Delivery");
    expect(sp).toContain("Your role: member");
    expect(sp).toContain(`### Delivery SOP\n${SOP.id}`);
    expect(sp).not.toContain("Your subagents");
    expect(mock.lastOptions!.agents).toBeUndefined();
  });

  it("a head sees the other divisions and has handoff_to_division; a member does not", async () => {
    const { ws, kirana } = await squad();
    const hendra = await employee(ws.id, { name: "Hendra", role: "Support Lead" });
    await makeDivision(ws.id, { name: "Support", key: "support", head: hendra });
    const mock = mockRunner([{ result: "ok" }]);
    setQueryImpl(mock.query);
    await runTask((await makeTask(ws.id, hendra.id)).id);
    const sp = String(mock.lastOptions!.systemPrompt);
    expect(sp).toContain("Your role: head of the division");
    expect(sp).toContain("- delivery: Delivery (head: Pratiwi)");
    expect(sp).toMatch(/- handoff_to_division \(reversible\)/);

    const m2 = mockRunner([{ result: "ok" }]);
    setQueryImpl(m2.query);
    await runTask((await makeTask(ws.id, kirana.id)).id);
    expect(String(m2.lastOptions!.systemPrompt)).not.toContain("handoff_to_division");
  });
});

describe("the code lead's subagents are the division's members", () => {
  it("builds the SDK agents map from the subagent members (Workspace mode)", async () => {
    const { ws, arif, citra, bima } = await squad();
    const mock = mockRunner([{ result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask((await makeTask(ws.id, arif.id)).id);
    const agents = mock.lastOptions!.agents!;
    expect(Object.keys(agents).sort()).toEqual(["bima-backend-developer", "citra-frontend-developer"]);
    const c = agents["citra-frontend-developer"]!;
    expect(c.description).toBe("Citra — Frontend Developer: React UI");
    expect(c.prompt).toContain("A careful frontend engineer.");
    expect(c.prompt).toContain("Use the design system components.");
    // the SOP and the language rule in the member's own language (Indonesian)
    expect(c.prompt).toContain(SOP.id);
    expect(c.prompt).toContain("Bahasa Indonesia");
    expect(c.prompt).toContain("subagent of Arif");
    expect(c.tools).toEqual(SUBAGENT_TOOLS);
    expect(c.model).toBe(citra.model);
    expect(agents["bima-backend-developer"]!.model).toBe(bima.model);
    expect(agents["bima-backend-developer"]!.prompt).toContain(SOP.en);
    const sp = String(mock.lastOptions!.systemPrompt);
    expect(sp).toContain("Your role: code lead");
    expect(sp).toContain("- citra-frontend-developer: Citra — Frontend Developer: React UI");
  });

  it("nobody else gets subagents: a Workspace-mode member, or the code lead in Tool mode", async () => {
    const { ws, arif, kirana } = await squad();
    await db.update(employees).set({ executionMode: "workspace" }).where(eq(employees.id, kirana.id));
    const mock = mockRunner([{ result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask((await makeTask(ws.id, kirana.id)).id);
    expect(mock.started).toBe(1);
    expect(mock.lastOptions!.agents).toBeUndefined();

    await db.update(employees).set({ executionMode: "tool" }).where(eq(employees.id, arif.id));
    const tool = mockRunner([{ result: "ok" }]);
    setQueryImpl(tool.query);
    await runTask((await makeTask(ws.id, arif.id)).id);
    expect(tool.lastOptions!.agents).toBeUndefined();
  });

  it("the code lead's build subtask from the head runs in Workspace mode with the subagents", async () => {
    const { ws, pm, arif, division } = await squad();
    const parent = await makeTask(ws.id, pm.id, { teamId: division.id, status: "RUNNING", phase: "wait" });
    const sub = await makeTask(ws.id, arif.id, { teamId: division.id, parentTaskId: parent.id, title: "Build it" });
    const mock = mockRunner([{ result: "built" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(sub.id);
    expect(Object.keys(mock.lastOptions!.agents ?? {})).toHaveLength(2);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, sub.id));
    expect(t!.status).toBe("DONE");
  });

  it("records each subagent invocation and tool call under the member and counts its tokens once", async () => {
    const { ws, arif, citra } = await squad();
    const key = subagentKey(citra.name, citra.role);
    const task = await makeTask(ws.id, arif.id);
    const sub = (event: Record<string, unknown>): MockStep => ({ event: { type: "stream_event", parent_tool_use_id: "toolu_task_1", session_id: "s", event } });
    const script: MockStep[] = [
      {
        event: {
          type: "assistant",
          parent_tool_use_id: null,
          session_id: "s",
          message: {
            id: "msg_main_1",
            model: "claude-sonnet-5-5",
            role: "assistant",
            type: "message",
            content: [{ type: "tool_use", id: "toolu_task_1", name: "Task", input: { subagent_type: key, description: "Build the page", prompt: "Make the check-in page" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
      },
      sub({ type: "message_start", message: { id: "msg_sub_1", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 1 } } }),
      sub({ type: "message_delta", usage: { output_tokens: 200 } }),
      sub({ type: "message_stop" }),
      { tool: "Bash", input: { command: "ls" }, parentToolUseId: "toolu_task_1", toolUseId: "toolu_sub_bash" },
      // only the code lead pushes: a subagent's platform tool call is refused whatever the code lead is granted
      { tool: "mcp__wfos__git_push", input: {}, parentToolUseId: "toolu_task_1", toolUseId: "toolu_sub_push" },
      {
        event: {
          type: "user",
          parent_tool_use_id: null,
          session_id: "s",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task_1", content: "Done: page built" }] },
        },
      },
      { result: "ok" },
    ];
    const mock = mockRunner(script);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(task.id);

    const push = mock.calls.find((c) => c.name === "mcp__wfos__git_push")!;
    expect(push.permission.behavior).toBe("deny");
    expect((push.permission as { message: string }).message).toMatch(/Subagents cannot use platform/);
    // the subagent's shell call went through the code lead's gate (a local, reversible command is allowed)
    expect(mock.calls.find((c) => c.name === "Bash")!.permission.behavior).toBe("allow");

    const rows = await db.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(steps.createdAt);
    expect(rows.every((r) => r.employeeId === arif.id || r.employeeId === null)).toBe(true);
    const byActor = rows.filter((r) => r.actorEmployeeId === citra.id);
    expect(byActor.map((r) => r.name)).toEqual(expect.arrayContaining(["subagent_started", "llm_call", "Bash", "mcp__wfos__git_push", "subagent_finished"]));
    expect(byActor.find((r) => r.name === "subagent_started")!.input).toMatchObject({ subagent: key, description: "Build the page" });
    expect(byActor.find((r) => r.name === "subagent_finished")!.output).toBe("Done: page built");
    expect(byActor.find((r) => r.name === "Bash")).toMatchObject({ kind: "tool", status: "ok", input: { command: "ls" } });
    expect(byActor.find((r) => r.name === "mcp__wfos__git_push")!.status).toBe("error");
    const subLlm = byActor.find((r) => r.name === "llm_call")!;
    expect(subLlm).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    expect(subLlm.credits).toBeGreaterThan(0);
    const llm = rows.filter((r) => r.kind === "llm");
    expect(llm).toHaveLength(2);
    expect(llm.filter((r) => !r.actorEmployeeId)).toHaveLength(1);
    // the task's cost is every step's credits, each turn counted once
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t!.costCredits).toBeCloseTo(rows.reduce((a, r) => a + r.credits, 0), 6);
    // the realtime step carries the actor for the UI
    const ev = transport.published.map((p) => p.ev as { step?: { name: string; actorEmployeeId?: string } }).find((e) => e.step?.name === "subagent_started");
    expect(ev!.step!.actorEmployeeId).toBe(citra.id);
  });
});

describe("division concurrency (teams.max_parallel)", () => {
  it("a division runs at most max_parallel tasks at once, across its members; chat replies are not held", async () => {
    const { ws, pm, kirana } = await squad();
    const t1 = await makeTask(ws.id, pm.id);
    const t2 = await makeTask(ws.id, kirana.id);
    const a = await acquireRunLeases({ kind: "task", taskId: t1.id, workspaceId: ws.id }, "job-1", 5);
    expect(a.ok).toBe(true);
    const b = await acquireRunLeases({ kind: "task", taskId: t2.id, workspaceId: ws.id }, "job-2", 5);
    expect(b).toMatchObject({ ok: false, busy: "division" });
    // the employee lease taken before the division check was given back: a chat reply of hers runs
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: kirana.id }).returning();
    const chat = await acquireRunLeases({ kind: "chat", conversationId: conv!.id, messageId: "m", workspaceId: ws.id }, "job-3", 1);
    expect(chat.ok).toBe(true);
    await chat.release();
    await a.release();
    const c = await acquireRunLeases({ kind: "task", taskId: t2.id, workspaceId: ws.id }, "job-2", 5);
    expect(c.ok).toBe(true);
    await c.release();
  });

  it("max_parallel 2 lets two members run at once; an employee in no division is not limited", async () => {
    const ws = await makeWorkspace();
    const a1 = await makeEmployee(ws.id);
    const a2 = await makeEmployee(ws.id);
    const a3 = await makeEmployee(ws.id);
    const loner = await makeEmployee(ws.id);
    await makeDivision(ws.id, { head: a1, members: [{ emp: a2 }, { emp: a3 }], maxParallel: 2 });
    const job = async (e: { id: string }, id: string) => acquireRunLeases({ kind: "task", taskId: (await makeTask(ws.id, e.id)).id, workspaceId: ws.id }, id, 5);
    expect((await job(a1, "j1")).ok).toBe(true);
    expect((await job(a2, "j2")).ok).toBe(true);
    expect((await job(a3, "j3")).ok).toBe(false);
    expect((await job(loner, "j4")).ok).toBe(true);
  });

  it("renews both leases while the run is held and stops on release (a run may outlast the 30-minute TTL)", async () => {
    const { ws, kirana, division } = await squad();
    const t = await makeTask(ws.id, kirana.id);
    const leases = await acquireRunLeases({ kind: "task", taskId: t.id, workspaceId: ws.id }, "job-hb", 5, { refreshMs: 20 });
    expect(leases.ok).toBe(true);
    // pretend both were taken long ago: the heartbeat moves them to now
    await redis.multi().zadd(employeeLeaseKey(kirana.id), 1, "job-hb").zadd(divisionLeaseKey(division.id), 1, "job-hb").exec();
    await new Promise((r) => setTimeout(r, 80));
    const fresh = Date.now() - 5_000;
    expect(Number(await redis.zscore(employeeLeaseKey(kirana.id), "job-hb"))).toBeGreaterThan(fresh);
    expect(Number(await redis.zscore(divisionLeaseKey(division.id), "job-hb"))).toBeGreaterThan(fresh);
    await leases.release();
    await new Promise((r) => setTimeout(r, 60));
    // released and not re-added by a late refresh
    expect(await redis.zscore(employeeLeaseKey(kirana.id), "job-hb")).toBeNull();
    expect(await redis.zscore(divisionLeaseKey(division.id), "job-hb")).toBeNull();
  });

  it("gives the employee lease back when taking the division lease throws", async () => {
    const { ws, kirana } = await squad();
    const t = await makeTask(ws.id, kirana.id);
    const orig = redis.multi;
    let calls = 0;
    redis.multi = ((...a: Parameters<typeof orig>) => {
      // the first multi is the employee lease, the second the division lease
      if (++calls === 2) throw new Error("redis went away");
      return orig(...a);
    }) as typeof orig;
    try {
      await expect(acquireRunLeases({ kind: "task", taskId: t.id, workspaceId: ws.id }, "job-x", 5)).rejects.toThrow("redis went away");
    } finally {
      redis.multi = orig;
    }
    expect(calls).toBe(2);
    expect(await redis.zscore(employeeLeaseKey(kirana.id), "job-x")).toBeNull();
    // the employee can run again right away
    const again = await acquireRunLeases({ kind: "task", taskId: t.id, workspaceId: ws.id }, "job-y", 1);
    expect(again.ok).toBe(true);
    await again.release();
  });
});

describe("division daily budget", () => {
  it("holds a member's run once the division's members (and subagents acting for them) spent the budget today", async () => {
    const { ws, kirana, citra, arif, division } = await squad();
    // 3 credits by the code lead's run, 4 acted by a subagent in it: 7 in all (each step counted once)
    await recordStep({ workspaceId: ws.id, employeeId: arif.id, kind: "llm", name: "llm_call", credits: 3 });
    await recordStep({ workspaceId: ws.id, employeeId: arif.id, actorEmployeeId: citra.id, kind: "llm", name: "llm_call", credits: 4 });
    await db.update(teams).set({ dailyBudget: 7 }).where(eq(teams.id, division.id));
    const mock = mockRunner([{ result: "ok" }]);
    setQueryImpl(mock.query);
    const task = await makeTask(ws.id, kirana.id);
    await runTask(task.id);
    expect(mock.started).toBe(0);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t!.status).toBe("QUEUED");
    expect(t!.error).toBe("Paused: Division daily budget reached (7.00 / 7 credits)");
    const [cap] = await db.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.name, "division_budget_cap")));
    expect(cap).toMatchObject({ kind: "budget", status: "blocked" });
    // tried again after the budget day rolls over; the owners are told once per division and day
    expect(transport.queued.some((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === task.id)).toBe(true);
    expect(limitsNotices()).toHaveLength(1);
    await runTask(task.id);
    expect(limitsNotices()).toHaveLength(1);
    // the member is not paused: only the division's runs are held
    const [k] = await db.select().from(employees).where(eq(employees.id, kirana.id));
    expect(k!.status).toBe("ACTIVE");

    // under the budget the run goes ahead
    await db.update(teams).set({ dailyBudget: 100 }).where(eq(teams.id, division.id));
    await runTask(task.id);
    expect(mock.started).toBe(1);
  });
});

describe("workspace slots", () => {
  it("limits concurrent Workspace-mode runs on the host (default 1)", async () => {
    const { acquireWorkspaceSlot, releaseWorkspaceSlot } = await import("../src/runner/workspace/slots");
    expect(await acquireWorkspaceSlot("run-a")).toBe(true);
    expect(await acquireWorkspaceSlot("run-b")).toBe(false);
    await releaseWorkspaceSlot("run-a");
    expect(await acquireWorkspaceSlot("run-b")).toBe(true);
    await releaseWorkspaceSlot("run-b");
  });
});
