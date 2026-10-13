import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, auditLog, clients, db, employees, members, outboundEmails, tasks, users, workspaces } from "@wfos/db";
import type { Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listOutbox } from "@/app/api/outbox/route";
import { GET as getOutbox } from "@/app/api/outbox/[id]/route";
import { POST as resend } from "@/app/api/outbox/[id]/resend/route";
import { GET as getPolicy, PUT as putPolicy } from "@/app/api/settings/email-policy/route";
import { GET as listTasks } from "@/app/api/tasks/route";
import { GET as getTask } from "@/app/api/tasks/[id]/route";
import type { OutboxItem } from "@/lib/outbox";
import { call, callWithParams, queueModule, resetBrowser } from "./browser";

beforeEach(() => {
  resetBrowser();
  queueModule.q.misc.mockClear();
});

async function workspace(settings: Record<string, unknown> = {}) {
  const [ws] = await db
    .insert(workspaces)
    .values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false, settings, timezone: "Asia/Jakarta" })
    .returning();
  const [sari] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  const [client] = await db
    .insert(clients)
    .values({
      workspaceId: ws!.id,
      name: "PT Maju",
      email: "info@maju.co.id",
      contacts: [
        { name: "Ana", email: "Ana@Maju.co.id", role: "billing" },
        { name: "Budi", email: "budi@maju.co.id", role: "project", phone: "", receives: { status: true, minutes: false, invoice: false } },
      ],
    })
    .returning();
  return { ws: ws!, sari: sari!, client: client! };
}

async function signIn(workspaceId: string, role: Role = "ADMIN") {
  const email = `o-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "O", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role });
  resetBrowser();
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return u!;
}

const emailPayload = (to: string[], extra: Record<string, unknown> = {}) => ({ to, cc: [], subject: "Status update", body: "Hello", ...extra });

async function approval(workspaceId: string, v: Partial<typeof approvals.$inferInsert> = {}) {
  const [a] = await db
    .insert(approvals)
    .values({ workspaceId, toolName: "send_email", title: "Email the client", payload: emailPayload(["ana@maju.co.id"]), ...v })
    .returning();
  return a!;
}

async function outbound(workspaceId: string, v: Partial<typeof outboundEmails.$inferInsert> = {}) {
  const [o] = await db
    .insert(outboundEmails)
    .values({ workspaceId, kind: "email", status: "sent", trigger: "approval", to: ["ana@maju.co.id"], subject: "Sent one", body: "b", payload: {}, ...v })
    .returning();
  return o!;
}

const items = async (qs = "") => {
  const r = await call(listOutbox, "GET", `/api/outbox${qs}`);
  expect(r.status).toBe(200);
  return r.json as { items: OutboxItem[]; stats: { sentToday: number; failedToday: number; pending: number; dailyLimit: number; paused: boolean } };
};

describe("GET /api/outbox", () => {
  it("merges attempts with email proposals, without duplicates, and only this workspace's", async () => {
    const { ws, sari, client } = await workspace();
    const other = await workspace();
    const pending = await approval(ws.id, { employeeId: sari.id, payload: emailPayload(["ana@maju.co.id"], { clientId: client.id }) });
    const rejected = await approval(ws.id, { status: "REJECTED", feedback: "Too blunt" });
    const expired = await approval(ws.id, { status: "EXPIRED" });
    const executing = await approval(ws.id, { status: "EXECUTING" });
    // approved and already sent: the outbound row stands for it, the approval is not listed again
    const done = await approval(ws.id, { status: "EXECUTED" });
    const sent = await outbound(ws.id, { approvalId: done.id, employeeId: sari.id, clientId: client.id });
    const failedAppr = await approval(ws.id, { status: "FAILED" });
    const failed = await outbound(ws.id, { approvalId: failedAppr.id, status: "failed", error: "SMTP 550" });
    // other tools and other workspaces never show
    await approval(ws.id, { toolName: "post_webhook", payload: { url: "x" } });
    await approval(other.ws.id);
    await outbound(other.ws.id);
    await signIn(ws.id, "VIEWER");

    const { items: list, stats } = await items();
    const byId = new Map(list.map((i) => [i.id, i]));
    expect([...byId.keys()].sort()).toEqual(
      [`approval:${pending.id}`, `approval:${rejected.id}`, `approval:${expired.id}`, `approval:${executing.id}`, sent.id, failed.id].sort(),
    );
    expect(byId.get(`approval:${pending.id}`)).toMatchObject({ source: "approval", approvalId: pending.id, status: "pending_approval", kind: "email", employee: { id: sari.id, name: "Sari" }, client: { id: client.id, name: "PT Maju" } });
    expect(byId.get(`approval:${rejected.id}`)).toMatchObject({ status: "rejected", error: "Too blunt" });
    expect(byId.get(`approval:${expired.id}`)!.status).toBe("expired");
    expect(byId.get(`approval:${executing.id}`)!.status).toBe("sending");
    expect(byId.get(sent.id)).toMatchObject({ source: "email", approvalId: done.id, status: "sent", trigger: "approval", employee: { name: "Sari" } });
    expect(byId.get(failed.id)).toMatchObject({ status: "failed", error: "SMTP 550" });
    expect(stats).toMatchObject({ sentToday: 1, failedToday: 1, pending: 1, dailyLimit: 100, paused: false });

    // filters
    expect((await items("?status=pending_approval,failed")).items.map((i) => i.id).sort()).toEqual([`approval:${pending.id}`, failed.id].sort());
    expect((await items(`?clientId=${client.id}`)).items.map((i) => i.id).sort()).toEqual([`approval:${pending.id}`, sent.id].sort());
    expect((await items("?kind=invoice")).items).toEqual([]);
  });

  it("annotates recipients against the client master", async () => {
    const { ws, client } = await workspace();
    const second = await db.insert(clients).values({ workspaceId: ws.id, name: "CV Lain", email: "", contacts: [{ name: "Citra", email: "citra@lain.id", role: "director" }] }).returning();
    // with a client: only that client's file counts
    const withClient = await approval(ws.id, { payload: emailPayload(['"Ana" <ANA@maju.co.id>', "citra@lain.id"], { cc: ["info@maju.co.id"], clientId: client.id }) });
    // without: any client in the workspace
    const noClient = await outbound(ws.id, { to: ["citra@lain.id", "stranger@gmail.com"] });
    await signIn(ws.id, "VIEWER");
    const { items: list } = await items();
    expect(list.find((i) => i.id === `approval:${withClient.id}`)!.recipients).toEqual([
      { email: "ana@maju.co.id", known: true, contactName: "Ana", role: "billing" },
      { email: "citra@lain.id", known: false },
      { email: "info@maju.co.id", known: true, contactName: "PT Maju" },
    ]);
    expect(list.find((i) => i.id === noClient.id)!.recipients).toEqual([
      { email: "citra@lain.id", known: true, contactName: "Citra", role: "director" },
      { email: "stranger@gmail.com", known: false },
    ]);
    expect(second).toHaveLength(1);
  });

  it("shows an invoice proposal with its PDF and counts sent mail since local midnight", async () => {
    const { ws, client } = await workspace({ email: { paused: true, dailyLimit: 5 } });
    await approval(ws.id, { toolName: "send_invoice", payload: { clientId: client.id, invoiceNumber: "INV-2026-0001", lines: [], to: [], subject: "", body: "", dueDate: "2026-11-01" } });
    // yesterday (well before any local midnight) does not count
    await outbound(ws.id, { createdAt: new Date(Date.now() - 36 * 3600_000) });
    await outbound(ws.id);
    await signIn(ws.id, "VIEWER");
    const { items: list, stats } = await items();
    const inv = list.find((i) => i.kind === "invoice")!;
    expect(inv).toMatchObject({ subject: "INV-2026-0001", attachments: [{ filename: "INV-2026-0001.pdf", size: 0 }], recipients: [] });
    expect(stats).toMatchObject({ sentToday: 1, pending: 1, dailyLimit: 5, paused: true });
  });
});

describe("GET /api/outbox/[id]", () => {
  it("returns one line by either id form, never another workspace's", async () => {
    const { ws } = await workspace();
    const other = await workspace();
    const a = await approval(ws.id);
    const o = await outbound(ws.id);
    const foreign = await outbound(other.ws.id);
    await signIn(ws.id, "VIEWER");
    expect((await callWithParams(getOutbox, "GET", "/api/outbox/x", undefined, { id: `approval:${a.id}` })).json.item).toMatchObject({ approvalId: a.id, status: "pending_approval" });
    expect((await callWithParams(getOutbox, "GET", "/api/outbox/x", undefined, { id: o.id })).json.item).toMatchObject({ id: o.id, status: "sent" });
    for (const id of [foreign.id, "not-a-uuid", `approval:${randomUUID()}`]) {
      const r = await callWithParams(getOutbox, "GET", "/api/outbox/x", undefined, { id });
      expect(r.status).toBe(404);
      expect(r.json.code).toBe("outbox_not_found");
    }
  });
});

describe("POST /api/outbox/[id]/resend", () => {
  it("queues a failed email again (ADMIN), audited", async () => {
    const { ws } = await workspace();
    const failed = await outbound(ws.id, { status: "failed", error: "timeout" });
    const u = await signIn(ws.id, "ADMIN");
    const r = await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: failed.id });
    expect(r.status).toBe(200);
    expect(queueModule.q.misc).toHaveBeenCalledWith({ kind: "outbox_resend", emailId: failed.id, workspaceId: ws.id, userId: u.id });
    const logged = await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws.id));
    expect(logged.map((l) => l.action)).toContain("outbox.resend");
    // a second click while the first is on its way
    const again = await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: failed.id });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("outbox_already_resent");
    expect(queueModule.q.misc).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but a failed email with 409, members with 403, other workspaces with 404", async () => {
    const { ws } = await workspace();
    const other = await workspace();
    const sent = await outbound(ws.id, { status: "sent" });
    const sending = await outbound(ws.id, { status: "sending" });
    const failed = await outbound(ws.id, { status: "failed" });
    const foreign = await outbound(other.ws.id, { status: "failed" });
    await signIn(ws.id, "MEMBER");
    expect((await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: failed.id })).status).toBe(403);
    await signIn(ws.id, "ADMIN");
    for (const o of [sent, sending]) {
      const r = await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: o.id });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("outbox_not_failed");
    }
    expect((await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: foreign.id })).status).toBe(404);
    expect((await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: `approval:${randomUUID()}` })).status).toBe(404);
    // resent once already (even if that attempt failed too): not again — the newer attempt is the one to retry
    const retry = await outbound(ws.id, { status: "failed", trigger: "resend", resendOf: failed.id });
    const again = await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: failed.id });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("outbox_already_resent");
    expect(queueModule.q.misc).not.toHaveBeenCalled();
    const { items: list } = await items();
    expect(list.find((i) => i.id === failed.id)).toMatchObject({ resentAs: retry.id, resendOf: null });
    expect(list.find((i) => i.id === retry.id)).toMatchObject({ resentAs: null, resendOf: failed.id, trigger: "resend" });
    expect((await callWithParams(resend, "POST", "/api/outbox/x/resend", undefined, { id: retry.id })).status).toBe(200);
  });
});

describe("/api/settings/email-policy", () => {
  it("reads defaults, merges a partial update and keeps the other settings keys", async () => {
    const company = { legalName: "PT Kita", invoicePrefix: "KT" };
    const { ws } = await workspace({ company, other: { x: 1 } });
    await signIn(ws.id, "MEMBER");
    expect((await call(getPolicy, "GET", "/api/settings/email-policy")).json.policy).toEqual({ paused: false, dailyLimit: 100 });
    expect((await call(putPolicy, "PUT", "/api/settings/email-policy", { paused: true })).status).toBe(403);
    await signIn(ws.id, "ADMIN");
    const r = await call(putPolicy, "PUT", "/api/settings/email-policy", { paused: true });
    expect(r.status).toBe(200);
    expect(r.json.policy).toEqual({ paused: true, dailyLimit: 100 });
    expect((await call(putPolicy, "PUT", "/api/settings/email-policy", { dailyLimit: 25 })).json.policy).toEqual({ paused: true, dailyLimit: 25 });
    expect((await call(putPolicy, "PUT", "/api/settings/email-policy", { dailyLimit: 0 })).status).toBe(400);
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row!.settings).toEqual({ company, other: { x: 1 }, email: { paused: true, dailyLimit: 25 } });
    const logged = await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws.id));
    expect(logged.filter((l) => l.action === "settings.email_policy_changed")).toHaveLength(2);
  });
});

describe("task progress in the tasks API", () => {
  it("reports the assignee's progress, else derives it from subtasks (cancelled ones left out)", async () => {
    const { ws, sari } = await workspace();
    const at = new Date();
    const [reported] = await db.insert(tasks).values({ workspaceId: ws.id, title: "Reported", assigneeId: sari.id, status: "RUNNING", progress: 40, progressNote: "Drafted", progressAt: at }).returning();
    const [parent] = await db.insert(tasks).values({ workspaceId: ws.id, title: "Parent", assigneeId: sari.id, status: "RUNNING" }).returning();
    for (const status of ["DONE", "DONE", "RUNNING", "CANCELLED"] as const) {
      await db.insert(tasks).values({ workspaceId: ws.id, title: `sub ${status}`, assigneeId: sari.id, parentTaskId: parent!.id, status });
    }
    const [bare] = await db.insert(tasks).values({ workspaceId: ws.id, title: "Bare", assigneeId: sari.id }).returning();
    await signIn(ws.id, "VIEWER");

    const list = (await call(listTasks, "GET", "/api/tasks")).json.tasks as { id: string; progress: number | null; progressNote: string | null; progressAt: string | null; progressDerived: boolean }[];
    const by = new Map(list.map((x) => [x.id, x]));
    expect(by.get(reported!.id)).toMatchObject({ progress: 40, progressNote: "Drafted", progressAt: at.toISOString(), progressDerived: false });
    expect(by.get(parent!.id)).toMatchObject({ progress: 67, progressNote: null, progressDerived: true });
    expect(by.get(bare!.id)).toMatchObject({ progress: null, progressDerived: false });

    const detail = await callWithParams(getTask, "GET", `/api/tasks/${parent!.id}`, undefined, { id: parent!.id });
    expect(detail.json.task).toMatchObject({ progress: 67, progressDerived: true });
    const own = await callWithParams(getTask, "GET", `/api/tasks/${reported!.id}`, undefined, { id: reported!.id });
    expect(own.json.task).toMatchObject({ progress: 40, progressNote: "Drafted", progressDerived: false });
  });
});
