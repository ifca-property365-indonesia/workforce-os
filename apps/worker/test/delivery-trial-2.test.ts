import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, employees, incidents, steps, tasks } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl, setWorkspaceQueryFactory, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { platformToolsProblem, unavailableToolCalls } from "../src/runner/executor";
import { unresolvedSubtasks } from "../src/orchestration/team";
import {
  DEFAULT_LIMITS,
  DEFAULT_MEMORY_MAX_MB,
  parseUnitEnd,
  SandboxOutOfMemoryError,
  unitEndResult,
  unitFailureError,
} from "../src/runner/workspace/unit";
import { makeDivision, makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => {
  setQueryImpl(null);
  setWorkspaceQueryFactory(null);
});

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const stepsNamed = (taskId: string, name: string) => db.select().from(steps).where(and(eq(steps.taskId, taskId), eq(steps.name, name)));
const enqueuedRuns = (taskId: string) => transport.queued.filter((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === taskId);
const resumeNoteOf = (q: { data: unknown }) => String((q.data as { resumeNote?: string }).resumeNote ?? "");

async function employee(workspaceId: string, values: Partial<typeof employees.$inferInsert>) {
  const e = await makeEmployee(workspaceId, { toolPermissions: [{ tool: "draft_document", enabled: true }] });
  const [r] = await db.update(employees).set(values).where(eq(employees.id, e.id)).returning();
  return r!;
}

/** The second trial: head Pratiwi, Kirana's design DONE, Arif's build (Workspace mode) after it. */
async function trial(build: Partial<typeof tasks.$inferInsert> = {}) {
  const ws = await makeWorkspace();
  const pm = await employee(ws.id, { name: "Pratiwi", role: "Project Manager", model: "claude-opus-5-5" });
  const arif = await employee(ws.id, { name: "Arif", role: "Tech Lead", executionMode: "workspace", model: "claude-opus-5-5" });
  const kirana = await employee(ws.id, { name: "Kirana", role: "UI/UX Designer" });
  const division = await makeDivision(ws.id, { name: "Delivery", key: "delivery", head: pm, codeLead: arif, members: [{ emp: kirana }] });
  const parent = await makeTask(ws.id, pm.id, { teamId: division.id, status: "RUNNING", phase: "wait", title: "Perbaiki UI/UX aplikasi buku tamu", brief: "Improve the guest book UI." });
  const design = await makeTask(ws.id, kirana.id, { teamId: division.id, parentTaskId: parent.id, source: "team", status: "DONE", title: "Design", result: "spec" });
  const buildTask = await makeTask(ws.id, arif.id, { teamId: division.id, parentTaskId: parent.id, source: "team", title: "Build", brief: "Build it.", dependsOn: [design.id], ...build });
  return { ws, pm, arif, kirana, division, parent, design, build: buildTask };
}

/** The real journal lines of an OOM-killed transient unit (systemd 259, captured on the production host). */
const OOM_JOURNAL = [
  { MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", MESSAGE: "Started wfos-run-x.service.", _PID: "1" },
  { MESSAGE_ID: "fe6faa94e7774663a0da52717891d8ef", MESSAGE: "wfos-run-x.service: The kernel OOM killer killed some processes in this unit.", _PID: "1" },
  { MESSAGE: "wfos-run-x.service: Killing process 1881220 (python3) with signal SIGKILL.", _PID: "1" },
  { MESSAGE_ID: "98e322203f7a4ed290d09fe03c09fe15", MESSAGE: "wfos-run-x.service: Main process exited, code=killed, status=9/KILL", _PID: "1" },
  { MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "oom-kill", MESSAGE: "wfos-run-x.service: Failed with result 'oom-kill'.", _PID: "1" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("problem 1: an OOM-killed sandbox fails with a clear error and an out_of_memory incident", () => {
  it("the default memory limit is 2048 MB", () => {
    expect(DEFAULT_MEMORY_MAX_MB).toBe(2048);
    if (!process.env.WORKSPACE_MEMORY_MAX_MB) expect(DEFAULT_LIMITS.memoryMaxMb).toBe(2048);
  });

  it("reads how the unit ended from systemd's journal entries (PID 1 only)", () => {
    expect(parseUnitEnd(OOM_JOURNAL)).toBe("oom-kill");
    expect(parseUnitEnd(JSON.stringify({ MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "timeout", _PID: "1" }))).toBe("timeout");
    expect(parseUnitEnd(JSON.stringify({ MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "exit-code", _PID: "1" }))).toBe("exit-code");
    // the sandbox can write to journald, but not as PID 1
    expect(parseUnitEnd(JSON.stringify({ MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "oom-kill", _PID: "4242" }))).toBeNull();
    expect(parseUnitEnd("not json\n\n")).toBeNull();
    expect(parseUnitEnd("")).toBeNull();
  });

  it("re-reads a journal that has no entry yet, and never throws", async () => {
    let reads = 0;
    const late = async () => (++reads < 3 ? "" : OOM_JOURNAL);
    expect(await unitEndResult("wfos-run-x", { read: late, delayMs: 1 })).toBe("oom-kill");
    expect(reads).toBe(3);
    expect(await unitEndResult("wfos-run-x", { read: async () => Promise.reject(new Error("no journalctl")), delayMs: 1 })).toBeNull();
    expect(await unitEndResult("wfos-run-x", { read: async () => "", attempts: 2, delayMs: 1 })).toBeNull();
  });

  it("an OOM kill or a timeout becomes a clear error; anything else keeps the exit code", () => {
    const limits = { ...DEFAULT_LIMITS, memoryMaxMb: 2048, runtimeMaxSec: 3600 };
    const oom = unitFailureError("oom-kill", limits, "");
    expect(oom).toBeInstanceOf(SandboxOutOfMemoryError);
    expect(oom!.message).toMatch(/^Sandbox ran out of memory \(limit 2048 MB\)/);
    expect(oom!.message).toMatch(/more memory \(WORKSPACE_MEMORY_MAX_MB\) or lighter steps/);
    expect(unitFailureError("timeout", limits, "")!.message).toMatch(/runtime limit \(3600 s\)/);
    expect(unitFailureError("exit-code", limits, "")).toBeNull();
    expect(unitFailureError(null, limits, "")).toBeNull();
  });

  it("the trial: Arif's sandbox is OOM-killed → the build fails with the memory error and an out_of_memory incident", async () => {
    const w = await trial();
    setWorkspaceQueryFactory(
      () =>
        (() =>
          (async function* () {
            yield* [];
            throw new SandboxOutOfMemoryError(2048, "");
          })()) as unknown as QueryFn,
    );
    await runTask(w.build.id);
    const b = await row(w.build.id);
    expect(b.status).toBe("FAILED");
    expect(b.error).toMatch(/^Sandbox ran out of memory \(limit 2048 MB\)/);
    expect(await stepsNamed(w.build.id, "run_out_of_memory")).toHaveLength(1);
    const [inc] = await db.select().from(incidents).where(eq(incidents.taskId, w.build.id));
    expect(inc).toMatchObject({ kind: "out_of_memory" });
    expect(inc!.summary).toMatch(/ran out of memory/);
  });
});

const init = (status: string, tools: string[]): MockStep => ({
  event: { type: "system", subtype: "init", session_id: "s", tools, mcp_servers: [{ name: "wfos", status, source: "sdk" }] },
});
const noSuchTool = (name: string): MockStep => ({
  event: {
    type: "user",
    parent_tool_use_id: null,
    session_id: "s",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${name}`, content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`, is_error: true }] },
  },
});

describe("problem 2: a run never goes on without its platform tools", () => {
  it("platformToolsProblem: connected with the tools is fine; failed, pending, missing or empty is a problem", () => {
    const tools = ["mcp__wfos__finish_review", "mcp__wfos__retry_subtask"];
    expect(platformToolsProblem({ tools, mcp_servers: [{ name: "wfos", status: "connected" }] }, ["finish_review", "retry_subtask"])).toBeNull();
    expect(platformToolsProblem({ tools: [], mcp_servers: [{ name: "wfos", status: "failed" }] }, ["finish_review"])).toMatch(/status: failed/);
    expect(platformToolsProblem({ tools: [], mcp_servers: [{ name: "wfos", status: "pending" }] }, ["finish_review"])).toMatch(/status: pending/);
    expect(platformToolsProblem({ tools: [], mcp_servers: [] }, ["finish_review"])).toMatch(/status: missing/);
    expect(platformToolsProblem({ tools: ["Bash"], mcp_servers: [{ name: "wfos", status: "connected" }] }, ["finish_review"])).toMatch(/listed none/);
    // nothing granted: nothing to check
    expect(platformToolsProblem({ tools: [], mcp_servers: [] }, [])).toBeNull();
  });

  it("unavailableToolCalls reads Claude Code's refusals from tool results", () => {
    expect(
      unavailableToolCalls([
        { type: "tool_result", content: "<tool_use_error>Error: No such tool available: retry_subtask</tool_use_error>", is_error: true },
        { type: "tool_result", content: [{ type: "text", text: "Error: No such tool available: mcp__wfos__finish_review" }], is_error: true },
        { type: "tool_result", content: "ok" },
        { type: "text", text: "No such tool available: not_a_result" },
      ]),
    ).toEqual(["retry_subtask", "mcp__wfos__finish_review"]);
    expect(unavailableToolCalls("x")).toEqual([]);
  });

  it("the system prompt tells the model the full tool names", async () => {
    const w = await trial({ status: "DONE", result: "built" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    const mock = mockRunner([{ tool: "mcp__wfos__finish_review", input: { outcome: "accept", notes: "All criteria met." } }, { result: "Done." }]);
    setQueryImpl(mock.query);
    await runTask(w.parent.id);
    expect(String(mock.lastOptions?.systemPrompt)).toMatch(/Call each by its full name: mcp__wfos__<name> \(e\.g\. mcp__wfos__\w+\)/);
    expect((await row(w.parent.id)).status).toBe("DONE");
  });

  it("init says the platform server is not connected → the head's review fails at once (never DONE)", async () => {
    const w = await trial({ status: "FAILED", error: "sandbox exited with code 1: no output" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    const mock = mockRunner([init("failed", []), { llm: { input: 10, output: 10, text: "I will review." } }, { result: "Everything is fine." }]);
    setQueryImpl(mock.query);
    await runTask(w.parent.id);
    const p = await row(w.parent.id);
    expect(p.status).toBe("FAILED");
    expect(p.error).toMatch(/The platform tools were not available to this run \(tool server "wfos" status: failed\)/);
    expect(await stepsNamed(w.parent.id, "run_tools_unavailable")).toHaveLength(1);
    expect(await db.select().from(incidents).where(eq(incidents.taskId, w.parent.id))).toHaveLength(1);
  });

  it("the trial: every platform tool is refused with 'No such tool available' → an error step, and the run fails", async () => {
    const w = await trial({ status: "FAILED", error: "sandbox exited with code 1: no output" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    const mock = mockRunner([
      init("connected", ["mcp__wfos__retry_subtask", "mcp__wfos__finish_review"]),
      { llm: { input: 10, output: 10 } },
      noSuchTool("retry_subtask"),
      { llm: { input: 10, output: 10 } },
      noSuchTool("finish_review"),
      { result: "Every tool I tried was refused with No such tool available." },
    ]);
    setQueryImpl(mock.query);
    await runTask(w.parent.id);
    const [s] = await stepsNamed(w.parent.id, "tool_unavailable");
    expect(s).toMatchObject({ kind: "tool", status: "error", input: { tool: "retry_subtask" } });
    const p = await row(w.parent.id);
    expect(p.status).toBe("FAILED");
    expect(p.error).toMatch(/called the platform tool "retry_subtask" without its full name \(mcp__wfos__retry_subtask\)/);
    // stopped at the first refusal: the second never ran
    expect(await stepsNamed(w.parent.id, "tool_unavailable")).toHaveLength(1);
  });

  it("an unknown tool that is not a platform tool is recorded but does not stop the run", async () => {
    const w = await trial({ status: "DONE", result: "built" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    setQueryImpl(mockRunner([init("connected", ["mcp__wfos__finish_review"]), noSuchTool("WebSearch"), { tool: "mcp__wfos__finish_review", input: { outcome: "accept", notes: "All criteria met." } }, { result: "Done." }]).query);
    await runTask(w.parent.id);
    expect(await stepsNamed(w.parent.id, "tool_unavailable")).toHaveLength(1);
    expect((await row(w.parent.id)).status).toBe("DONE");
  });
});

describe("problem 3: a review never ends DONE while a subtask failed and nothing was decided", () => {
  it("unresolvedSubtasks: failed and blocked count; a reassigned failure does not", async () => {
    const w = await trial({ status: "FAILED" });
    const later = await makeTask(w.ws.id, w.kirana.id, { teamId: w.division.id, parentTaskId: w.parent.id, source: "team", title: "QA", dependsOn: [w.build.id], phase: "blocked" });
    expect((await unresolvedSubtasks(w.parent.id)).map((u) => [u.id, u.state])).toEqual([
      [w.build.id, "FAILED"],
      [later.id, "BLOCKED"],
    ]);
    // reassign_subtask replaced the build with a new subtask: the failure is resolved (the QA now waits for the new one)
    await makeTask(w.ws.id, w.arif.id, { teamId: w.division.id, parentTaskId: w.parent.id, source: "team", title: "Build", originTaskId: w.build.id, status: "DONE" });
    await db.update(tasks).set({ status: "CANCELLED" }).where(eq(tasks.id, later.id));
    expect(await unresolvedSubtasks(w.parent.id)).toEqual([]);
  });

  it("the trial: the build FAILED and the head ends without a verdict → back to the head once, then FAILED with an incident", async () => {
    const w = await trial({ status: "FAILED", error: "Sandbox ran out of memory (limit 700 MB)" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    setQueryImpl(mockRunner([{ result: "Kirana's design is good; the build failed." }]).query);
    await runTask(w.parent.id);
    expect(await row(w.parent.id)).toMatchObject({ status: "RUNNING", phase: "review" });
    const [flag] = await stepsNamed(w.parent.id, "team_review_unresolved");
    expect(flag).toMatchObject({ status: "flagged" });
    const runs = enqueuedRuns(w.parent.id);
    expect(runs).toHaveLength(1);
    expect(resumeNoteOf(runs[0]!)).toMatch(/"Build" \(.+, failed\).*retry_subtask or reassign_subtask.*finish_review/s);

    setQueryImpl(mockRunner([{ result: "Still nothing to add." }]).query);
    await runTask(w.parent.id);
    const p = await row(w.parent.id);
    expect(p.status).toBe("FAILED");
    expect(p.error).toMatch(/The review ended without a verdict while subtasks had failed: "Build"/);
    expect(await db.select().from(incidents).where(eq(incidents.taskId, w.parent.id))).toHaveLength(1);
  });

  it("finish_review accept with a failed subtask ends DONE (the head decided)", async () => {
    const w = await trial({ status: "FAILED" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    setQueryImpl(mockRunner([{ tool: "mcp__wfos__finish_review", input: { outcome: "accept", notes: "The design alone is the deliverable; the build follows." } }, { result: "Accepted." }]).query);
    await runTask(w.parent.id);
    expect((await row(w.parent.id)).status).toBe("DONE");
    expect(await stepsNamed(w.parent.id, "team_review_unresolved")).toHaveLength(0);
  });

  it("finish_review fail ends FAILED with the head's notes", async () => {
    const w = await trial({ status: "FAILED" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    setQueryImpl(mockRunner([{ tool: "mcp__wfos__finish_review", input: { outcome: "fail", notes: "The build ran out of memory." } }, { result: "Failed." }]).query);
    await runTask(w.parent.id);
    expect(await row(w.parent.id)).toMatchObject({ status: "FAILED", error: "The division head did not accept the work: The build ran out of memory." });
  });

  it("a review of finished work still ends DONE without a verdict", async () => {
    const w = await trial({ status: "DONE", result: "built" });
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, w.parent.id));
    setQueryImpl(mockRunner([{ result: "All criteria met." }]).query);
    await runTask(w.parent.id);
    expect((await row(w.parent.id)).status).toBe("DONE");
  });
});
