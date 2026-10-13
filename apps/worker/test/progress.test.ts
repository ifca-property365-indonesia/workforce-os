import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversations, db, steps, tasks } from "@wfos/db";
import type { RealtimeEvent } from "@wfos/shared";
import { buildTools, grantedToolNames } from "../src/tools/registry";
import { buildSystemPrompt } from "../src/runner/prompt";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

const textOf = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

const events = () => transport.published.map((p) => p.ev as RealtimeEvent);

async function setup(status: "RUNNING" | "QUEUED" = "RUNNING") {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const task = await makeTask(ws.id, emp.id, { status });
  const ctx = runContext(ws, emp, task.id);
  const report = (args: { percent: number; note?: string }) => buildTools(ctx).find((d) => d.name === "report_progress")!.handler(args, {});
  return { ws, emp, task, ctx, report };
}

const progressOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

describe("report_progress", () => {
  it("is granted to every task run, never to a chat run, and an explicit disabled entry wins", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
    const task = await makeTask(ws.id, emp.id);
    expect(grantedToolNames(runContext(ws, emp, task.id))).toContain("mcp__wfos__report_progress");
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: emp.id }).returning();
    const chat = runContext(ws, emp, null, { conversationId: conv!.id });
    expect(grantedToolNames(chat)).not.toContain("mcp__wfos__report_progress");
    expect(buildTools(chat).map((d) => d.name)).not.toContain("report_progress");

    const off = runContext(ws, { ...emp, toolPermissions: [{ tool: "report_progress", enabled: false }] }, task.id);
    expect(grantedToolNames(off)).not.toContain("mcp__wfos__report_progress");
  });

  it("the task prompt asks for progress reports only when the tool is granted", () => {
    const base = {
      employee: { id: "e", name: "Sari", role: "Finance", persona: "", instructions: "", businessContext: "", autonomyLevel: "QUEUE" as const },
      workspaceName: "WS",
      directory: "",
      dryRun: false,
    };
    expect(buildSystemPrompt({ ...base, mode: "task", grantedTools: ["report_progress"] })).toMatch(/call report_progress once the plan is clear/);
    expect(buildSystemPrompt({ ...base, mode: "task", grantedTools: [] })).not.toMatch(/report_progress once/);
    expect(buildSystemPrompt({ ...base, mode: "chat", grantedTools: [] })).not.toMatch(/report_progress once/);
  });

  it("writes the progress, records a step and publishes task.progress", async () => {
    const { task, report } = await setup();
    const r = await report({ percent: 40, note: "Plan done, invoices drafted" });
    expect(r.isError).toBeFalsy();
    const t = await progressOf(task.id);
    expect(t).toMatchObject({ progress: 40, progressNote: "Plan done, invoices drafted" });
    expect(t.progressAt).toBeInstanceOf(Date);
    expect(events()).toContainEqual({ type: "task.progress", taskId: task.id, progress: 40, note: "Plan done, invoices drafted" });
    const [step] = await db.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.name, "report_progress")));
    expect(step).toMatchObject({ kind: "tool", status: "ok", credits: 0 });
  });

  it("goes down only with a note (the scope grew)", async () => {
    const { task, report } = await setup();
    await report({ percent: 60 });
    const down = await report({ percent: 30 });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toMatch(/already 60%.*note/);
    expect((await progressOf(task.id)).progress).toBe(60);

    const ok = await report({ percent: 30, note: "Client added two more invoices" });
    expect(ok.isError).toBeFalsy();
    expect(await progressOf(task.id)).toMatchObject({ progress: 30, progressNote: "Client added two more invoices" });
    // the same value again needs no note
    expect((await report({ percent: 30 })).isError).toBeFalsy();
  });

  it("a re-run (revision, retry) starts over: progress from an earlier run can go down without a note", async () => {
    const { task, report } = await setup();
    const hourAgo = new Date(Date.now() - 3_600_000);
    // 80% reported in the previous run; this run started after it
    await db.update(tasks).set({ progress: 80, progressNote: "old run", progressAt: hourAgo, startedAt: new Date(hourAgo.getTime() + 60_000) }).where(eq(tasks.id, task.id));
    const r = await report({ percent: 10 });
    expect(r.isError).toBeFalsy();
    expect(await progressOf(task.id)).toMatchObject({ progress: 10, progressNote: null });
    // within this run the usual rule holds again
    const down = await report({ percent: 5 });
    expect(down.isError).toBe(true);
    expect((await progressOf(task.id)).progress).toBe(10);
  });

  it("is refused when the task is not running", async () => {
    const { task, report } = await setup("QUEUED");
    const r = await report({ percent: 50 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/only while the task is running \(it is QUEUED\)/);
    expect((await progressOf(task.id)).progress).toBeNull();
    expect(events().some((e) => e.type === "task.progress")).toBe(false);
  });
});
