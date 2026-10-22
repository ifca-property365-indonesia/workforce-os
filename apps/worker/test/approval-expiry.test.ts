import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, conversations, db, MERGE_TOOL, messages, tasks, workspaces } from "@wfos/db";
import { expireUnansweredApprovals } from "../src/runner/approvals";
import { makeApproval, makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe("approvals nobody decides expire (fail closed)", () => {
  it("expires a task's approval after the workspace's hours; the employee hears it did not run, once", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const task = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
    const old = await makeApproval(ws.id, task.id, emp.id, { title: "Email: Kickoff", createdAt: hoursAgo(169) });
    const fresh = await makeApproval(ws.id, (await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" })).id, emp.id, { createdAt: hoursAgo(10) });

    const ids = await expireUnansweredApprovals();
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(fresh.id);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, old.id));
    expect(a!.status).toBe("EXPIRED");
    expect(a!.executionResult).toMatchObject({ ok: false, unanswered: true, summary: "Not decided within 168 hours", consumed: true });
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe("QUEUED");
    const job = transport.queued.find((j) => (j.data as { taskId?: string }).taskId === task.id);
    expect(JSON.stringify(job!.data)).toContain('Your proposed \\"Email: Kickoff\\" was not decided in time and EXPIRED, so it did not run.');
    expect(await db.select().from(auditLog).where(and(eq(auditLog.targetId, old.id), eq(auditLog.action, "approval.expired")))).toHaveLength(1);
    expect(transport.published.some((p) => JSON.stringify(p.ev).includes(`"approvalId":"${old.id}","status":"EXPIRED"`))).toBe(true);

    // a second sweep finds nothing new
    expect(await expireUnansweredApprovals()).not.toContain(old.id);
  });

  it("0 hours means never; merges are left alone", async () => {
    const off = await makeWorkspace();
    await db.update(workspaces).set({ approvalExpiryHours: 0 }).where(eq(workspaces.id, off.id));
    const emp = await makeEmployee(off.id);
    const a = await makeApproval(off.id, null, emp.id, { createdAt: hoursAgo(5000) });
    const ws = await makeWorkspace();
    const emp2 = await makeEmployee(ws.id);
    const merge = await makeApproval(ws.id, null, emp2.id, { toolName: MERGE_TOOL, createdAt: hoursAgo(500) });
    const ids = await expireUnansweredApprovals();
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(merge.id);
  });

  it("a chat's approval gets an expired receipt in the thread", async () => {
    const ws = await makeWorkspace();
    await db.update(workspaces).set({ approvalExpiryHours: 24, defaultLocale: "id" }).where(eq(workspaces.id, ws.id));
    const emp = await makeEmployee(ws.id);
    const [c] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: emp.id }).returning();
    const a = await makeApproval(ws.id, null, emp.id, { conversationId: c!.id, title: "Email: Promo", createdAt: hoursAgo(25) });
    expect(await expireUnansweredApprovals()).toContain(a.id);
    const [m] = await db.select().from(messages).where(eq(messages.conversationId, c!.id));
    expect(m!.content).toBe("⌛ Tidak diputuskan dalam 24 jam, jadi tidak dijalankan: Email: Promo");
    expect(m!.meta).toMatchObject({ approvalId: a.id });
  });
});
