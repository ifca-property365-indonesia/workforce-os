import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, db, steps, tasks } from "@wfos/db";
import { applyRunSignals } from "@wfos/shared";
import { runTask, untrustedLineage } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

const allowListed = {
  autonomyLevel: "CLOSE" as const,
  toolPermissions: [{ tool: "send_email", enabled: true }],
  allowList: [{ tool: "send_email", recipientDomains: ["client.co.id"], clientIds: [], note: "" }],
};
const email = { to: ["ana@client.co.id"], subject: "Status", body: "Weekly status." };
/** what applyRunSignals turns an allow-listed irreversible "run" into once the run is tainted */
const TAINTED = applyRunSignals({ kind: "run", rule: "allow_list" }, { toolClass: "irreversible", tainted: true });
const TAINT_REASON = "reason" in TAINTED ? TAINTED.reason : "";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

describe("tasks created from untrusted input (webhooks)", () => {
  it("precondition: the same allow-listed email runs unattended in an ordinary task", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, allowListed);
    const task = await makeTask(ws.id, emp.id);
    setQueryImpl(mockRunner([{ tool: "mcp__wfos__send_email", input: email }, { result: "sent" }]).query);
    await runTask(task.id);
    expect(transport.mails).toHaveLength(1);
    expect(await db.select().from(approvals).where(eq(approvals.taskId, task.id))).toHaveLength(0);
  });

  it("starts the run tainted: an allow-listed CLOSE send_email needs an approval (rule taint)", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, allowListed);
    const task = await makeTask(ws.id, emp.id, { source: "webhook", untrustedInput: true });
    setQueryImpl(mockRunner([{ tool: "mcp__wfos__send_email", input: email }, { result: "queued" }]).query);
    await runTask(task.id);
    expect(transport.mails).toHaveLength(0);
    const rows = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", toolName: "send_email", reason: TAINT_REASON });
    expect(TAINTED).toMatchObject({ kind: "approval", rule: "taint" });
    const guard = await db.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.name, "untrusted_input")));
    expect(guard).toHaveLength(1);
    expect(guard[0]).toMatchObject({ kind: "guard", status: "flagged" });
  });

  it("records the untrusted_input step once per task, not once per run", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const task = await makeTask(ws.id, emp.id, { source: "webhook", untrustedInput: true });
    setQueryImpl(mockRunner([{ result: "done" }]).query);
    await runTask(task.id);
    await db.update(tasks).set({ status: "QUEUED" }).where(eq(tasks.id, task.id));
    setQueryImpl(mockRunner([{ result: "done again" }]).query);
    await runTask(task.id);
    expect(await db.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.name, "untrusted_input")))).toHaveLength(1);
  });

  it("sub-tasks and follow-ups of an untrusted task inherit the taint", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, allowListed);
    const root = await makeTask(ws.id, emp.id, { source: "webhook", untrustedInput: true });
    const child = await makeTask(ws.id, emp.id, { parentTaskId: root.id });
    const followUp = await makeTask(ws.id, emp.id, { originTaskId: child.id });
    const clean = await makeTask(ws.id, emp.id);
    expect(await untrustedLineage(child)).toBe(true);
    expect(await untrustedLineage(followUp)).toBe(true);
    expect(await untrustedLineage(clean)).toBe(false);

    setQueryImpl(mockRunner([{ tool: "mcp__wfos__send_email", input: email }, { result: "queued" }]).query);
    await runTask(followUp.id);
    expect(transport.mails).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.taskId, followUp.id))).toHaveLength(1);
  });
});
