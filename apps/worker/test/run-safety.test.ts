import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { and, eq } from "drizzle-orm";
import { db, steps } from "@wfos/db";
import {
  REPEAT_ABORT_AT,
  REPEAT_ABORT_AT_REVERSIBLE,
  REPEAT_DENY_AT,
  REPEAT_DENY_AT_REVERSIBLE,
  RUN_TOOL_CAP_FACTOR,
  repeatLimits,
  runAgent,
  setRunIdleTimeoutMs,
  stableStringify,
  withRepeatGuard,
} from "../src/runner/executor";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { activeRunCount } from "../src/guards/killswitch";
import { makeEmployee, makeWorkspace, runContext } from "./fixtures";

afterEach(() => {
  setQueryImpl(null);
  setRunIdleTimeoutMs(null);
});

const run = (ctx: ReturnType<typeof runContext>) => runAgent({ ctx, model: "claude-sonnet-5-5", systemPrompt: "", prompt: "x", creditBudget: 100 });

async function crmEmployee() {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "mcp:crm", enabled: true }] });
  return { ws, emp };
}

describe("idle watchdog", () => {
  it("stops a run that sends no SDK event for longer than the idle timeout", async () => {
    const { ws, emp } = await crmEmployee();
    setRunIdleTimeoutMs(60);
    const mock = mockRunner([{ llm: { input: 10, output: 10 } }, { wait: 5_000 }, { result: "never" }]);
    setQueryImpl(mock.query);
    const t0 = Date.now();
    const out = await run(runContext(ws, emp, null));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out.stopped).toBe("stalled");
    expect(out.error).toMatch(/^No activity for .+ minutes — the run was stopped\.$/);
    expect(activeRunCount()).toBe(0);
  });

  it("does not fire while events keep arriving within the timeout", async () => {
    const { ws, emp } = await crmEmployee();
    setRunIdleTimeoutMs(300);
    const script: MockStep[] = [];
    for (let i = 0; i < 6; i++) script.push({ wait: 80 }, { llm: { input: 1, output: 1 } });
    script.push({ result: "done" });
    setQueryImpl(mockRunner(script).query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("completed");
    expect(out.text).toBe("done");
  });
});

describe("idle watchdog and long tool calls", () => {
  it("a tool call still in flight pauses the idle clock", async () => {
    const { ws, emp } = await crmEmployee();
    setRunIdleTimeoutMs(100);
    // 250ms inside one tool call: longer than the idle timeout, shorter than the 3× cap
    const mock = mockRunner([{ tool: "mcp__crm__list_contacts", input: {}, durationMs: 250 }, { result: "done" }]);
    setQueryImpl(mock.query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("completed");
    expect(out.text).toBe("done");
  });

  it(`a tool call that never returns is still stopped as stalled after ${RUN_TOOL_CAP_FACTOR}× the idle timeout`, async () => {
    const { ws, emp } = await crmEmployee();
    setRunIdleTimeoutMs(60);
    const mock = mockRunner([{ tool: "mcp__crm__list_contacts", input: {}, durationMs: 10_000 }, { result: "never" }]);
    setQueryImpl(mock.query);
    const t0 = Date.now();
    const out = await run(runContext(ws, emp, null));
    const took = Date.now() - t0;
    expect(out.stopped).toBe("stalled");
    expect(out.error).toMatch(/^A tool call ran for more than .+ minutes without any other activity — the run was stopped\.$/);
    expect(took).toBeGreaterThanOrEqual(60 * RUN_TOOL_CAP_FACTOR - 10);
    expect(took).toBeLessThan(2_000);
    expect(activeRunCount()).toBe(0);
  });

  it("a denied call does not count as in flight", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [] });
    setRunIdleTimeoutMs(60);
    setQueryImpl(mockRunner([{ tool: "mcp__crm__list_contacts", input: {} }, { wait: 5_000 }, { result: "never" }]).query);
    const t0 = Date.now();
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("stalled");
    expect(out.error).toMatch(/^No activity for/);
    expect(Date.now() - t0).toBeLessThan(60 * RUN_TOOL_CAP_FACTOR);
  });

  it("a safety stop after the successful result does not replace it", async () => {
    const { ws, emp } = await crmEmployee();
    setRunIdleTimeoutMs(60);
    setQueryImpl(mockRunner([{ result: "all done" }, { wait: 5_000 }]).query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("completed");
    expect(out.text).toBe("all done");
    expect(out.error).toBeUndefined();
  });
});

describe("repeat detector", () => {
  it("limits: irreversible 3/5, reversible and Workspace-mode Bash/Read/Grep/Glob 6/10", () => {
    expect([REPEAT_DENY_AT, REPEAT_ABORT_AT, REPEAT_DENY_AT_REVERSIBLE, REPEAT_ABORT_AT_REVERSIBLE]).toEqual([3, 5, 6, 10]);
    expect(repeatLimits("mcp__crm__send_note", false)).toEqual({ denyAt: 3, abortAt: 5 });
    expect(repeatLimits("mcp__crm__list_contacts", false)).toEqual({ denyAt: 6, abortAt: 10 });
    expect(repeatLimits("mcp__wfos__send_email", false)).toEqual({ denyAt: 3, abortAt: 5 });
    expect(repeatLimits("mcp__wfos__kb_search", false)).toEqual({ denyAt: 6, abortAt: 10 });
    for (const t of ["Bash", "Read", "Grep", "Glob"]) expect(repeatLimits(t, true)).toEqual({ denyAt: 6, abortAt: 10 });
    expect(repeatLimits("Write", true)).toEqual({ denyAt: 3, abortAt: 5 });
  });

  it("irreversible: denies the 3rd identical call in a row and stops the run on the 5th", async () => {
    const { ws, emp } = await crmEmployee();
    const call: MockStep = { tool: "mcp__crm__send_note", input: { to: "acme", text: "hi" } };
    const mock = mockRunner([call, call, call, call, call, call, { result: "never" }]);
    setQueryImpl(mock.query);
    const out = await run(runContext(ws, emp, null));

    expect(out.stopped).toBe("loop");
    expect(out.error).toBe("The same tool call repeated 5 times in a row — the run was stopped.");
    // the 6th call never happens: the run was aborted after the 5th
    expect(mock.calls).toHaveLength(REPEAT_ABORT_AT);
    const third = mock.calls[REPEAT_DENY_AT - 1]!.permission;
    expect(third.behavior === "deny" && third.message).toBe(
      "You already called mcp__crm__send_note 2 times in a row with exactly these arguments. Change your approach or explain what's blocking you.",
    );

    const guard = await db
      .select()
      .from(steps)
      .where(and(eq(steps.workspaceId, ws.id), eq(steps.name, "repeat_detected")))
      .orderBy(steps.createdAt);
    expect(guard.map((s) => [s.kind, s.status, s.input])).toEqual([
      ["guard", "denied", { tool: "mcp__crm__send_note", count: 3 }],
      ["guard", "denied", { tool: "mcp__crm__send_note", count: 4 }],
      ["guard", "stopped", { tool: "mcp__crm__send_note", count: 5 }],
    ]);
  });

  it("reversible: identical reads are allowed 5 times in a row, denied from the 6th, stopped on the 10th", async () => {
    const { ws, emp } = await crmEmployee();
    const call: MockStep = { tool: "mcp__crm__list_contacts", input: { q: "acme", page: 1 } };
    const mock = mockRunner([...Array.from({ length: 12 }, () => call), { result: "never" }]);
    setQueryImpl(mock.query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("loop");
    expect(out.error).toBe("The same tool call repeated 10 times in a row — the run was stopped.");
    expect(mock.calls).toHaveLength(REPEAT_ABORT_AT_REVERSIBLE);
    expect(mock.calls.map((c) => c.permission.behavior)).toEqual([...Array(5).fill("allow"), ...Array(5).fill("deny")]);
  });

  it("counts attempts the gate itself denied", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [] });
    const call: MockStep = { tool: "mcp__crm__delete_contact", input: {} };
    const mock = mockRunner([call, call, call, call, call, { result: "never" }]);
    setQueryImpl(mock.query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("loop");
    expect(mock.calls.every((c) => c.permission.behavior === "deny")).toBe(true);
  });

  it("only consecutive repeats count: another call in between resets the streak", async () => {
    const { ws, emp } = await crmEmployee();
    const a: MockStep = { tool: "mcp__crm__send_note", input: { text: "hi" } };
    const b: MockStep = { tool: "mcp__crm__list_contacts", input: {} };
    const script: MockStep[] = [];
    for (let i = 0; i < 4; i++) script.push(a, a, b);
    script.push({ result: "done" });
    const mock = mockRunner(script);
    setQueryImpl(mock.query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("completed");
    expect(await db.select().from(steps).where(and(eq(steps.workspaceId, ws.id), eq(steps.name, "repeat_detected")))).toEqual([]);
  });

  it("different arguments or different tools do not trigger it", async () => {
    const { ws, emp } = await crmEmployee();
    const script: MockStep[] = [];
    for (let i = 0; i < 6; i++) script.push({ tool: "mcp__crm__list_contacts", input: { page: i } });
    for (let i = 0; i < 2; i++) script.push({ tool: "mcp__crm__get_contact", input: { page: 1 } }, { tool: "mcp__crm__list_deals", input: { page: 1 } });
    script.push({ result: "done" });
    const mock = mockRunner(script);
    setQueryImpl(mock.query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("completed");
    expect(mock.calls.every((c) => c.permission.behavior === "allow")).toBe(true);
    expect(await db.select().from(steps).where(and(eq(steps.workspaceId, ws.id), eq(steps.name, "repeat_detected")))).toEqual([]);
  });

  it("treats arguments with the same content in another key order as identical", async () => {
    const { ws, emp } = await crmEmployee();
    const mock = mockRunner([
      { tool: "mcp__crm__send_note", input: { a: 1, b: { c: 2, d: [1, 2] } } },
      { tool: "mcp__crm__send_note", input: { b: { d: [1, 2], c: 2 }, a: 1 } },
      { tool: "mcp__crm__send_note", input: { b: { c: 2, d: [1, 2] }, a: 1 } },
      { result: "done" },
    ]);
    setQueryImpl(mock.query);
    await run(runContext(ws, emp, null));
    const third = mock.calls[2]!.permission;
    expect(third.behavior === "deny" && third.message).toMatch(/2 times in a row/);
  });

  it("a loop detected after another stop does not override that stop's reason", async () => {
    const { ws, emp } = await crmEmployee();
    // a run killed from outside, then the model still repeats a call 5 times before the SDK notices
    const query = ((params: Parameters<QueryFn>[0]) => {
      const opts = params.options!;
      async function* gen(): AsyncGenerator<SDKMessage> {
        opts.abortController!.abort(new Error("Stopped by kill switch"));
        for (let i = 0; i < REPEAT_ABORT_AT; i++) {
          await (opts.canUseTool as CanUseTool)("mcp__crm__send_note", { text: "x" }, { signal: opts.abortController!.signal, toolUseID: `t${i}` } as never);
        }
        throw opts.abortController!.signal.reason;
      }
      return gen() as never;
    }) as QueryFn;
    setQueryImpl(query);
    const out = await run(runContext(ws, emp, null));
    expect(out.stopped).toBe("aborted");
    expect(out.error).toBe("Stopped by kill switch");
  });

  it("is fail-safe: onLoop runs before the step, and a failing step record never throws", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    // a workspace id with no row: every step insert fails (foreign key)
    const ctx = runContext({ id: randomUUID() }, emp, null);
    const loops: number[] = [];
    const guard = withRepeatGuard(ctx, async (_n, input) => ({ behavior: "allow", updatedInput: input }), (n) => loops.push(n));
    const results = [];
    for (let i = 0; i < REPEAT_ABORT_AT; i++) results.push(await guard("mcp__crm__send_note", { text: "x" }, { signal: new AbortController().signal } as never));
    expect(results.map((r) => r?.behavior)).toEqual(["allow", "allow", "deny", "deny", "deny"]);
    expect(loops).toEqual([REPEAT_ABORT_AT]);
  });

  it("stableStringify sorts keys at every level and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify("x")).toBe('"x"');
  });
});
