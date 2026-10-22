import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, incidents, steps, tasks, workspaces } from "@wfos/db";
import { failTask } from "../src/runner/task-status";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport } from "./transport";

beforeEach(() => resetTransport());

async function running() {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id);
  const task = await makeTask(ws.id, emp.id, { status: "RUNNING", progress: 60, progressNote: "draft ready, checking numbers" });
  const step = (name: string, status: string, output: unknown, s: number) =>
    db.insert(steps).values({ workspaceId: ws.id, taskId: task.id, employeeId: emp.id, kind: "tool", name, status, output, createdAt: new Date(Date.UTC(2026, 9, 23, 9, 0, s)) });
  await step("kb_search", "ok", "3 passages", 1);
  await step("gate:crm/list", "run", null, 2);
  await step("mcp:crm/list_contacts", "error", { error: "HTTP 502 from crm.example (api key sk-ant-api03-SECRETSECRETSECRETSECRET)" }, 3);
  await step("mcp:crm/list_contacts", "error", { error: "HTTP 502 from crm.example" }, 4);
  return { ws, emp, task };
}

describe("a stopped run says where it was", () => {
  it("a loop stop carries progress, the last actions with their outcome, and deliverables; secrets are redacted", async () => {
    const { task } = await running();
    expect(await failTask(task, "The same tool call repeated 5 times in a row.", { kind: "loop" })).toBe(true);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t!.error).toContain("The same tool call repeated 5 times in a row.\n\nWhere it was when it stopped:\nLast progress reported: 60% draft ready, checking numbers\nLast actions:\n- kb_search (ok)\n- mcp:crm/list_contacts (error: HTTP 502 from crm.example (api key");
    expect(t!.error).not.toContain("SECRETSECRET");
    expect(t!.error).not.toContain("gate:");
    expect(t!.error).toContain("Deliverables so far: 0");
    const [inc] = await db.select().from(incidents).where(eq(incidents.taskId, task.id));
    expect(inc!.summary).toContain("Where it was when it stopped:");
  });

  it("is in the workspace's language, and an ordinary error gets no report", async () => {
    const a = await running();
    await db.update(workspaces).set({ defaultLocale: "id" }).where(eq(workspaces.id, a.ws.id));
    await failTask(a.task, "stalled", { kind: "stalled" });
    expect((await db.select().from(tasks).where(eq(tasks.id, a.task.id)))[0]!.error).toContain("Posisinya saat dihentikan:\nProgres terakhir yang dilaporkan: 60%");

    const b = await running();
    await failTask(b.task, "Tool crashed", { kind: "error" });
    expect((await db.select().from(tasks).where(eq(tasks.id, b.task.id)))[0]!.error).toBe("Tool crashed");
  });
});
