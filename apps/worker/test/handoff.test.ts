import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, db, employees, tasks } from "@wfos/db";
import { buildTools } from "../src/tools/registry";
import { executeApproval, handleRejection } from "../src/runner/approvals";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

const PRD = "# Export invoices to CSV\n\nGoal: …\n\nAcceptance criteria:\n- a CSV button on the invoices page";

async function setup() {
  const ws = await makeWorkspace();
  const pm = await makeEmployee(ws.id, { toolPermissions: [{ tool: "draft_document", enabled: true }] });
  await db.update(employees).set({ department: "project" }).where(eq(employees.id, pm.id));
  const dev = await makeEmployee(ws.id);
  await db.update(employees).set({ department: "developer", name: "Dewi" }).where(eq(employees.id, dev.id));
  const task = await makeTask(ws.id, pm.id, { title: "Scope the CSV export", status: "RUNNING" });
  const ctx = runContext(ws, pm, task.id);
  const draft = buildTools(ctx).find((d) => d.name === "draft_document")!;
  await draft.handler({ title: "CSV export", content: PRD, kind: "prd" }, {});
  await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, task.id));
  const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
  return { ws, pm, dev, task, a: a! };
}

beforeEach(() => resetTransport());

describe("Project → Developer handoff", () => {
  it("a PRD goes to the owner for review with the developer preselected", async () => {
    const { a, dev } = await setup();
    expect(a.toolName).toBe("handoff_prd");
    expect(a.status).toBe("PENDING");
    expect(a.payload).toMatchObject({ title: "CSV export", prd: PRD, developerId: dev.id, developerName: "Dewi" });
  });

  it("approving creates a linked Developer task carrying the PRD", async () => {
    const { a, dev, task, ws } = await setup();
    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a.id));
    await executeApproval(a.id);
    const created = (await db.select().from(tasks).where(eq(tasks.workspaceId, ws.id))).find((t) => t.originTaskId === task.id)!;
    expect(created.assigneeId).toBe(dev.id);
    expect(created.title).toBe("Implement: CSV export");
    expect(created.brief).toContain("a CSV button on the invoices page");
    expect(transport.queued.some((q) => q.queue === "runs" && (q.data as { taskId: string }).taskId === created.id)).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe("DONE");
  });

  it("rejecting with feedback sends the Project employee back to revise", async () => {
    const { a, task } = await setup();
    await db.update(approvals).set({ status: "REJECTED", feedback: "Add the date range filter to the scope." }).where(eq(approvals.id, a.id));
    await handleRejection(a.id);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t!.status).toBe("QUEUED");
    const q = transport.queued.find((x) => x.queue === "runs" && (x.data as { taskId: string }).taskId === task.id);
    expect((q!.data as { resumeNote: string }).resumeNote).toContain("Add the date range filter");
  });

  it("refuses to hand off without a developer", async () => {
    const { a, ws } = await setup();
    await db.update(approvals).set({ status: "APPROVED", editedPayload: { ...a.payload, developerId: null } }).where(eq(approvals.id, a.id));
    await executeApproval(a.id);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(after!.status).toBe("FAILED");
    expect((await db.select().from(tasks).where(eq(tasks.workspaceId, ws.id))).some((t) => t.originTaskId)).toBe(false);
  });
});
