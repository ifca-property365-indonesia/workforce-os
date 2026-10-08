import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { departments, db, employees, workspaceDepartments } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl, setWorkspaceQueryFactory, type QueryFn } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";

afterEach(() => {
  setQueryImpl(null);
  setWorkspaceQueryFactory(null);
});

function capture() {
  const mock = mockRunner([{ result: "ok" }]);
  return mock;
}

describe("departments", () => {
  it("copies the bilingual defaults into each workspace once", async () => {
    const ws = await makeWorkspace();
    const rows = await workspaceDepartments(ws.id);
    expect(rows.map((r) => r.key).sort()).toEqual(["developer", "finance", "marketing", "project"]);
    expect(rows.find((r) => r.key === "developer")!.subagents.map((a) => a.name)).toEqual(["backend", "frontend", "qa"]);
    expect((await workspaceDepartments(ws.id)).length).toBe(4);
  });

  it("gives a Workspace-mode Developer its subagents and SOP in its output language", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    await db.update(employees).set({ executionMode: "workspace", department: "developer", outputLanguage: "id" }).where(eq(employees.id, emp.id));
    const mock = capture();
    setWorkspaceQueryFactory(() => mock.query as QueryFn);
    await runTask((await makeTask(ws.id, emp.id)).id);
    const o = mock.lastOptions!;
    expect(Object.keys(o.agents ?? {})).toEqual(["backend", "frontend", "qa"]);
    expect(o.agents!.qa!.prompt).toMatch(/Anda adalah engineer QA/);
    expect(o.agents!.backend!.tools).toContain("Bash");
    expect(String(o.systemPrompt)).toMatch(/## Developer SOP\n1\. Baca tugas/);
    expect(String(o.systemPrompt)).toMatch(/Subagents you can delegate to with the Task tool: backend, frontend, qa/);
  });

  it("uses the workspace's edited SOP", async () => {
    const ws = await makeWorkspace();
    await workspaceDepartments(ws.id);
    await db.update(departments).set({ sop: { en: "Always write tests first.", id: "Selalu tulis tes dulu." } }).where(eq(departments.workspaceId, ws.id));
    const emp = await makeEmployee(ws.id);
    await db.update(employees).set({ department: "finance" }).where(eq(employees.id, emp.id));
    const mock = capture();
    setQueryImpl(mock.query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    expect(String(mock.lastOptions!.systemPrompt)).toContain("## Finance SOP\nAlways write tests first.");
    // Tool mode: SOP but no subagents (they need Claude Code's Task tool)
    expect(mock.lastOptions!.agents).toBeUndefined();
  });

  it("falls back to the template's department", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    await db.update(employees).set({ templateKey: "marketing" }).where(eq(employees.id, emp.id));
    const mock = capture();
    setQueryImpl(mock.query);
    await runTask((await makeTask(ws.id, emp.id)).id);
    expect(String(mock.lastOptions!.systemPrompt)).toContain("## Marketing SOP");
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
