import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, db, employees, steps, tasks } from "@wfos/db";
import { ROLE_TEMPLATES } from "@wfos/templates";
import { runTask } from "../src/runner/task";
import { setQueryImpl, setWorkspaceQueryFactory, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { subagentKey } from "../src/runner/division";
import {
  LEAD_REVIEW_CATEGORIES,
  leadReviewable,
  parseLeadReview,
  reviewSandboxCommand,
  setLeadReviewModelCall,
  setLeadReviewTimeoutMs,
  type LeadReviewModelCall,
} from "../src/runner/workspace/lead-review";
import { makeDivision, makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

/** Every AI review call of a test, with what the model was asked. */
let reviewCalls: Parameters<LeadReviewModelCall>[0][] = [];

/** A review model that answers `answer` (JSON text) after `delayMs`. */
function reviewModel(answer: string | (() => string), delayMs = 0): LeadReviewModelCall {
  return async (req) => {
    reviewCalls.push(req);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { text: typeof answer === "function" ? answer() : answer, model: req.model, usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  };
}
const verdict = (decision: string, reason: string) => JSON.stringify({ decision, reason });

beforeEach(() => {
  resetTransport();
  reviewCalls = [];
  // a review nobody scripted fails loudly (never the real Agent SDK)
  setLeadReviewModelCall(async (req) => {
    reviewCalls.push(req);
    throw new Error("unexpected AI review in this test");
  });
});
afterEach(() => {
  setQueryImpl(null);
  setWorkspaceQueryFactory(null);
  setLeadReviewModelCall(null);
  setLeadReviewTimeoutMs(null);
});

async function employee(workspaceId: string, values: Partial<typeof employees.$inferInsert>) {
  const e = await makeEmployee(workspaceId, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const [row] = await db.update(employees).set(values).where(eq(employees.id, e.id)).returning();
  return row!;
}

/** The trial's Delivery squad: head Pratiwi, code lead Arif (Workspace mode), member Kirana, subagents Citra, Bima, Gilang. */
async function delivery() {
  const ws = await makeWorkspace();
  const pm = await employee(ws.id, { name: "Pratiwi", role: "Project Manager", model: "claude-opus-5-5" });
  const arif = await employee(ws.id, { name: "Arif", role: "Tech Lead", executionMode: "workspace", model: "claude-opus-5-5", egressDomains: ["registry.npmjs.org"] });
  const kirana = await employee(ws.id, { name: "Kirana", role: "UI/UX Designer" });
  const citra = await employee(ws.id, { name: "Citra", role: "Frontend Developer" });
  const bima = await employee(ws.id, { name: "Bima", role: "Backend Developer" });
  const gilang = await employee(ws.id, { name: "Gilang", role: "QA Tester" });
  const division = await makeDivision(ws.id, {
    name: "Delivery",
    key: "delivery",
    head: pm,
    codeLead: arif,
    members: [{ emp: kirana }, { emp: citra, role: "subagent" }, { emp: bima, role: "subagent" }, { emp: gilang, role: "subagent" }],
  });
  // the head's task waits for its two ordered subtasks: Kirana's design (DONE), then Arif's build
  const parent = await makeTask(ws.id, pm.id, { teamId: division.id, status: "RUNNING", phase: "wait", title: "Buku Tamu: kolom Instansi", brief: "Add an optional Instansi field." });
  const design = await makeTask(ws.id, kirana.id, { teamId: division.id, parentTaskId: parent.id, source: "team", status: "DONE", title: "Design", result: "spec" });
  // phase null: onChildFinished claimed it once the design was DONE
  const build = await makeTask(ws.id, arif.id, { teamId: division.id, parentTaskId: parent.id, source: "team", title: "Build: kolom Instansi", brief: "Build the Instansi field.", dependsOn: [design.id], phase: null });
  return { ws, pm, arif, kirana, citra, bima, gilang, division, parent, design, build };
}

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const approvalsOf = (taskId: string) => db.select().from(approvals).where(eq(approvals.taskId, taskId));
const stepsNamed = (taskId: string, name: string) => db.select().from(steps).where(and(eq(steps.taskId, taskId), eq(steps.name, name)));
const enqueuedRuns = (taskId: string) => transport.queued.filter((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === taskId);

/** The code lead starts a subagent (Task tool use `toolu_task`) whose calls carry parent_tool_use_id. */
function subagentStart(key: string): MockStep {
  return {
    event: {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "s",
      message: { id: "msg_main_task", model: "claude-opus-5-5", role: "assistant", type: "message", content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { subagent_type: key, description: "Build the form", prompt: "Add the Instansi input" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } },
    },
  };
}

describe("trial regression: a member subtask's run never finishes DONE with a pending approval", () => {
  it("the code lead's command escalated to the owner leaves the subtask AWAITING_APPROVAL and the parent waiting", async () => {
    const w = await delivery();
    setLeadReviewModelCall(reviewModel(verdict("escalate", "A new dependency: the owner should decide.")));
    const mock = mockRunner([{ tool: "Bash", input: { command: "pnpm add zod" } }, { result: "Waiting for the approval of pnpm add zod." }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);

    expect(mock.calls[0]!.permission.behavior).toBe("deny");
    const [a] = await approvalsOf(w.build.id);
    expect(a).toMatchObject({ status: "PENDING", toolName: "bash" });
    expect(a!.payload).toMatchObject({ command: "pnpm add zod", leadReview: { decision: "escalate", reviewer: "Pratiwi" } });
    expect(await row(w.build.id)).toMatchObject({ status: "AWAITING_APPROVAL", phase: null });
    // the parent is not woken for review while the build waits
    expect(await row(w.parent.id)).toMatchObject({ status: "RUNNING", phase: "wait" });
    expect(await stepsNamed(w.parent.id, "team_review_started")).toHaveLength(0);
    expect(enqueuedRuns(w.parent.id)).toHaveLength(0);
  });

  it("a subagent's permission still being decided when the main turn ends: the run waits for it (no DONE, no review)", async () => {
    const w = await delivery();
    // Arif reviews Citra's command slowly, then escalates: the approval exists only after the main result
    setLeadReviewModelCall(reviewModel(verdict("escalate", "Unsure whether this download is needed."), 300));
    const key = subagentKey(w.citra.name, w.citra.role);
    const mock = mockRunner([
      subagentStart(key),
      { tool: "Bash", input: { command: "pnpm add date-fns" }, parentToolUseId: "toolu_task", background: true },
      { result: "Citra is working on the form." },
    ]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);

    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0]!.model).toBe(w.arif.model);
    const [a] = await approvalsOf(w.build.id);
    expect(a?.status).toBe("PENDING");
    expect(await row(w.build.id)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(await row(w.parent.id)).toMatchObject({ status: "RUNNING", phase: "wait" });
    expect(await stepsNamed(w.parent.id, "team_review_started")).toHaveLength(0);
  });

  it("the trial's two commands now run without anyone: the locked install and the heredoc that writes a file", async () => {
    const w = await delivery();
    const heredoc = [
      "cat > app/guestbook-form.tsx <<'EOF'",
      '"use client";',
      "export function GuestbookForm() {",
      "  const hint = `Instansi (maks. 120 karakter) $(python3 -)`;",
      "  return <input aria-label=\"Instansi\" maxLength={120} placeholder={hint} />;",
      "}",
      "EOF",
    ].join("\n");
    const repo = `/var/lib/private/wfos/ws/${w.ws.id}/${w.build.id}/repo`;
    const mock = mockRunner([
      { tool: "Bash", input: { command: "pnpm install --frozen-lockfile" } },
      { tool: "Bash", input: { command: heredoc } },
      { tool: "Bash", input: { command: `cd ${repo}; node --test` } },
      { result: "Built." },
    ]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    expect(mock.calls.map((c) => c.permission.behavior)).toEqual(["allow", "allow", "allow"]);
    expect(reviewCalls).toHaveLength(0);
    expect(await approvalsOf(w.build.id)).toHaveLength(0);
    expect((await row(w.build.id)).status).toBe("DONE");
  });

  it("subagents run in the foreground: a background Task is turned into a blocking one", async () => {
    const w = await delivery();
    const key = subagentKey(w.bima.name, w.bima.role);
    const mock = mockRunner([{ tool: "Task", input: { subagent_type: key, description: "API", prompt: "Add the column", run_in_background: true } }, { result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    expect(mock.calls[0]!.permission).toMatchObject({ behavior: "allow", updatedInput: { subagent_type: key, run_in_background: false } });
  });
});

describe("approval tiers: the AI lead reviews sandbox commands before the owner", () => {
  it("a subagent's command is reviewed by the code lead: allowed, recorded under the run with the reviewer as actor, credits on the task, audited", async () => {
    const w = await delivery();
    setLeadReviewModelCall(reviewModel(verdict("allow", "Needed for the date picker; stays in the workspace.")));
    const key = subagentKey(w.citra.name, w.citra.role);
    const mock = mockRunner([subagentStart(key), { tool: "Bash", input: { command: "pnpm add date-fns" }, parentToolUseId: "toolu_task" }, { result: "done" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);

    expect(mock.calls.find((c) => c.name === "Bash")!.permission.behavior).toBe("allow");
    expect(await approvalsOf(w.build.id)).toHaveLength(0);
    const [s] = await stepsNamed(w.build.id, "lead_review");
    expect(s).toMatchObject({ kind: "approval", employeeId: w.arif.id, actorEmployeeId: w.arif.id, status: "ok", model: w.arif.model });
    expect(s!.input).toMatchObject({ command: "pnpm add date-fns", category: "network", by: "subagent" });
    expect(s!.output).toMatchObject({ decision: "allow", reason: "Needed for the date picker; stays in the workspace.", reviewerName: "Arif", source: "model" });
    expect(s!.credits).toBeGreaterThan(0);
    expect((await row(w.build.id)).costCredits).toBeGreaterThanOrEqual(s!.credits);
    const [au] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, w.ws.id), eq(auditLog.action, "approval.lead_reviewed")));
    expect(au).toMatchObject({ actorLabel: "Arif (AI)", targetType: "task", targetId: w.build.id });
    expect(au!.details).toMatchObject({ decision: "allow", command: "pnpm add date-fns", reviewerId: w.arif.id });
    // the reviewer saw the task, the command and the classifier's notes as data
    expect(reviewCalls[0]!.prompt).toContain("<command>\npnpm add date-fns\n</command>");
    expect(reviewCalls[0]!.prompt).toContain("Build: kolom Instansi");
    expect(reviewCalls[0]!.system).toMatch(/one of your subagents/);
  });

  it("the code lead's own command is reviewed by the division head; a deny reaches the agent with the reason and no approval", async () => {
    const w = await delivery();
    setLeadReviewModelCall(reviewModel(verdict("deny", "Reads the environment file with secrets.")));
    const mock = mockRunner([{ tool: "Bash", input: { command: "unknowncli --dump-config" } }, { result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    const p = mock.calls[0]!.permission as { behavior: string; message: string };
    expect(p.behavior).toBe("deny");
    expect(p.message).toMatch(/^Denied by Pratiwi \(AI review\): Reads the environment file with secrets\. The command was NOT run/);
    expect(reviewCalls[0]!.model).toBe(w.pm.model);
    expect(reviewCalls[0]!.system).toMatch(/your code lead/);
    const [s] = await stepsNamed(w.build.id, "lead_review");
    expect(s).toMatchObject({ employeeId: w.arif.id, actorEmployeeId: w.pm.id, status: "denied" });
    expect(s!.input).toMatchObject({ by: "self", category: "unknown" });
    expect(await approvalsOf(w.build.id)).toHaveLength(0);
    // the denial is not recorded again as the command's output
    expect(await stepsNamed(w.build.id, "bash_output")).toHaveLength(0);
    expect((await row(w.build.id)).status).toBe("DONE");
  });

  it.each([
    ["publish", "git push origin main"],
    ["sensitive", "cat /proc/1/environ"],
  ])("never reviews a %s command: it stays with the owner", async (_cat, command) => {
    const w = await delivery();
    const mock = mockRunner([{ tool: "Bash", input: { command } }, { result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    expect(reviewCalls).toHaveLength(0);
    const [a] = await approvalsOf(w.build.id);
    expect(a!.status).toBe("PENDING");
    expect(a!.payload).not.toHaveProperty("leadReview");
  });

  it("a tainted run always goes to the owner", async () => {
    const w = await delivery();
    await db.update(tasks).set({ untrustedInput: true }).where(eq(tasks.id, w.build.id));
    const mock = mockRunner([{ tool: "Bash", input: { command: "pnpm add zod" } }, { result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    expect(reviewCalls).toHaveLength(0);
    expect((await approvalsOf(w.build.id))[0]!.status).toBe("PENDING");
  });

  it("an employee in no division, or the head itself, has no AI reviewer", async () => {
    const ws = await makeWorkspace();
    const loner = await employee(ws.id, { name: "Lone", executionMode: "workspace" });
    const mock = mockRunner([{ tool: "Bash", input: { command: "pnpm add zod" } }, { result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask((await makeTask(ws.id, loner.id)).id);
    expect(reviewCalls).toHaveLength(0);

    const w = await delivery();
    await db.update(employees).set({ executionMode: "workspace" }).where(eq(employees.id, w.pm.id));
    // a task assigned to the head directly (not a division task): the head in Workspace mode, nobody above
    const own = await makeTask(w.ws.id, w.pm.id, { title: "Spike" });
    await runTask(own.id);
    expect(reviewCalls).toHaveLength(0);
    expect((await approvalsOf(own.id))[0]!.status).toBe("PENDING");
  });

  it.each([
    ["an invalid answer", reviewModel("I think it is fine."), "invalid"],
    ["a model error", (async () => {
      throw new Error("overloaded");
    }) as LeadReviewModelCall, "error"],
    ["a timeout", reviewModel(verdict("allow", "late"), 500), "timeout"],
  ])("%s escalates to the owner", async (_label, model, source) => {
    const w = await delivery();
    setLeadReviewTimeoutMs(100);
    setLeadReviewModelCall(model);
    const mock = mockRunner([{ tool: "Bash", input: { command: "pnpm add zod" } }, { result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    const [s] = await stepsNamed(w.build.id, "lead_review");
    expect(s!.output).toMatchObject({ decision: "escalate", source });
    expect(s!.status).toBe("escalated");
    expect((await approvalsOf(w.build.id))[0]).toMatchObject({ status: "PENDING", toolName: "bash" });
    expect((await row(w.build.id)).status).toBe("AWAITING_APPROVAL");
  });

  it("goes through the Agent SDK by default (the mock runner), one turn without tools on the reviewer's model", async () => {
    const w = await delivery();
    setLeadReviewModelCall(null);
    const review = mockRunner([{ llm: { input: 500, output: 30, text: verdict("allow", "Fine.") } }, { result: verdict("allow", "Fine.") }]);
    setQueryImpl(review.query);
    const ctx = runContext(w.ws, w.arif, w.build.id);
    const r = await reviewSandboxCommand({
      ctx,
      reviewer: { id: w.pm.id, name: w.pm.name, model: w.pm.model, as: "head" },
      command: "pnpm add zod",
      category: "network",
      reasons: ["pnpm add downloads or changes dependencies"],
      by: "self",
      task: { title: "Build", brief: "Build it" },
      workspaceDir: "/var/lib/wfos/ws/x/y/repo",
    });
    expect(r).toEqual({ decision: "allow", reason: "Fine.", source: "model" });
    expect(review.lastOptions).toMatchObject({ model: w.pm.model, maxTurns: 1, tools: [] });
    const [s] = await stepsNamed(w.build.id, "lead_review");
    expect(s).toMatchObject({ inputTokens: 500, outputTokens: 30 });
  });
});

describe("lead review: parsing and scope", () => {
  it("parses the JSON verdict; anything else escalates", () => {
    expect(parseLeadReview('{"decision":"allow","reason":"ok to run"}')).toEqual({ decision: "allow", reason: "ok to run", source: "model" });
    expect(parseLeadReview('Here: {"decision":"DENY","reason":"exfiltrates"} done')).toMatchObject({ decision: "deny", source: "model" });
    expect(parseLeadReview('{"decision":"allow"}')).toMatchObject({ decision: "escalate", source: "invalid" });
    expect(parseLeadReview('{"decision":"maybe","reason":"x"}')).toMatchObject({ decision: "escalate", source: "invalid" });
    expect(parseLeadReview("allow")).toMatchObject({ decision: "escalate", source: "invalid" });
  });

  it("publish and sensitive are never AI-reviewed, nor anything in a tainted run", () => {
    expect(LEAD_REVIEW_CATEGORIES).toEqual(["network", "interpreter", "unknown", "config", "process", "escape"]);
    expect(leadReviewable("publish", false)).toBe(false);
    expect(leadReviewable("sensitive", false)).toBe(false);
    expect(leadReviewable("network", true)).toBe(false);
    expect(leadReviewable("interpreter", false)).toBe(true);
  });
});

describe("the code lead delegates implementation", () => {
  it("the system prompt says who implements what and that the code lead does glue only", async () => {
    const w = await delivery();
    const mock = mockRunner([{ result: "ok" }]);
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask(w.build.id);
    const sp = String(mock.lastOptions!.systemPrompt);
    expect(sp).toContain(`- ${subagentKey("Bima", "Backend Developer")}: Bima — Backend Developer → backend work`);
    expect(sp).toContain(`- ${subagentKey("Citra", "Frontend Developer")}: Citra — Frontend Developer → UI work`);
    expect(sp).toContain(`- ${subagentKey("Gilang", "QA Tester")}: Gilang — QA Tester → reviews the diff`);
    expect(sp).toMatch(/Do not implement features yourself\. Your own edits are small glue only/);
    expect(sp).toMatch(/never run_in_background/);
  });

  it("the Tech Lead template hands implementation to the subagents", () => {
    const t = ROLE_TEMPLATES.find((x) => x.key === "tech_lead")!;
    expect(t.instructions).toMatch(/Implementation always goes to your subagents/);
    expect(t.instructions).toMatch(/Do not build features yourself\. Your own edits are small glue only/);
    expect(t.instructions).toMatch(/QA engineer reviews the combined diff/);
  });
});
