import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, db, tasks, workspaces } from "@wfos/db";
import { executeApproval } from "../src/runner/approvals";
import { makeApproval, makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

async function approved(edited?: Record<string, unknown>) {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id);
  const task = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
  const a = await makeApproval(ws.id, task.id, emp.id, { status: "APPROVED", editedPayload: edited ?? null });
  return { ws, emp, task, a };
}

describe("approval execution", () => {
  it("executes the edited payload, not the original", async () => {
    const edited = { to: ["edited@client.co.id"], cc: [], subject: "Edited subject", body: "Edited body", html: false };
    const { a } = await approved(edited);
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(1);
    const m = transport.mails[0]!.mail;
    expect(m.to).toEqual(["edited@client.co.id"]);
    expect(m.subject).toBe("Edited subject");
    expect(m.text).toBe("Edited body");
    expect(JSON.stringify(m)).not.toContain("Original");
  });

  it("executes the original payload when nothing was edited", async () => {
    const { a } = await approved();
    await executeApproval(a.id);
    expect(transport.mails[0]!.mail.subject).toBe("Original");
  });

  it("is idempotent: a second run after success does nothing", async () => {
    const { a } = await approved();
    await executeApproval(a.id);
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(1);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(row!.status).toBe("EXECUTED");
  });

  it("is idempotent under concurrent execution (at most once)", async () => {
    const { a } = await approved();
    await Promise.all(Array.from({ length: 5 }, () => executeApproval(a.id)));
    expect(transport.mails).toHaveLength(1);
  });

  it("never executes a PENDING or REJECTED approval", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const p = await makeApproval(ws.id, null, emp.id, { status: "PENDING" });
    const r = await makeApproval(ws.id, null, emp.id, { status: "REJECTED" });
    await executeApproval(p.id);
    await executeApproval(r.id);
    expect(transport.mails).toHaveLength(0);
  });

  it("closes the task once its last approval executed", async () => {
    const { a, task } = await approved();
    await executeApproval(a.id);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t!.status).toBe("DONE");
  });

  it("does not execute when the kill switch is engaged", async () => {
    const { a, ws } = await approved();
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, ws.id));
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(0);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(row!.status).toBe("FAILED");
    expect((row!.executionResult as { summary: string }).summary).toMatch(/kill switch/i);
  });

  it("does not execute for a cancelled task", async () => {
    const { a, task } = await approved();
    await db.update(tasks).set({ status: "CANCELLED" }).where(eq(tasks.id, task.id));
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(0);
  });

  it("only simulates for a dry-run task", async () => {
    const { a, task } = await approved();
    await db.update(tasks).set({ dryRun: true }).where(eq(tasks.id, task.id));
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(0);
  });
});
