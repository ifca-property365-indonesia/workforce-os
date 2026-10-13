import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { approvals, auditLog, clients, credentials, db, getDb, outboundEmails, users, workspaces } from "@wfos/db";
import { emailPayloadSchema, type RealtimeEvent } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { executeApproval } from "../src/runner/approvals";
import { buildTools } from "../src/tools/registry";
import { failStuckSends, resendOutbound, sendEmailPayload, STUCK_SENDING_MS } from "../src/lib/outbox";
import { reapOrphanedTasks } from "../src/scheduler/reaper";
import { makeApproval, makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { mailModule, redisModule, resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

const events = () => transport.published.map((p) => p.ev as RealtimeEvent);
const rows = (workspaceId: string) => db.select().from(outboundEmails).where(eq(outboundEmails.workspaceId, workspaceId)).orderBy(desc(outboundEmails.createdAt));

async function approvedEmail(over: { settings?: Record<string, unknown> } = {}) {
  const ws = await makeWorkspace(over.settings ? { settings: over.settings } : {});
  const emp = await makeEmployee(ws.id);
  const task = await makeTask(ws.id, emp.id, { status: "AWAITING_APPROVAL" });
  const a = await makeApproval(ws.id, task.id, emp.id, { status: "APPROVED" });
  return { ws, emp, task, a };
}

async function user() {
  const [u] = await db.insert(users).values({ email: `o-${randomUUID().slice(0, 8)}@test.local`, name: "Owner", passwordHash: "x" }).returning();
  return u!;
}

describe("outbox: every send attempt is logged", () => {
  it("an approved email: a row goes sending → sent with the executed payload, and outbox.updated is published", async () => {
    const { ws, emp, task, a } = await approvedEmail();
    await executeApproval(a.id);
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({
      kind: "email",
      status: "sent",
      trigger: "approval",
      approvalId: a.id,
      taskId: task.id,
      employeeId: emp.id,
      to: ["original@client.co.id"],
      subject: "Original",
      body: "Original body",
      error: null,
      messageId: "<mock-1@test>",
    });
    expect(row!.sentAt).toBeInstanceOf(Date);
    expect(row!.payload).toMatchObject({ to: ["original@client.co.id"], subject: "Original" });
    const outbox = events().filter((e) => e.type === "outbox.updated");
    expect(outbox).toEqual([
      { type: "outbox.updated", emailId: row!.id, status: "sending" },
      { type: "outbox.updated", emailId: row!.id, status: "sent" },
    ]);
  });

  it("an allow-listed email (no human) is logged with trigger allow_list", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { autonomyLevel: "CLOSE", allowList: [{ tool: "send_email", recipientDomains: ["client.co.id"], clientIds: [] }] });
    const task = await makeTask(ws.id, emp.id, { status: "RUNNING" });
    const ctx = runContext(ws, emp, task.id);
    await buildTools(ctx).find((d) => d.name === "send_email")!.handler({ to: ["ana@client.co.id"], subject: "Status", body: "Weekly status." }, {});
    expect(transport.mails).toHaveLength(1);
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({ status: "sent", trigger: "allow_list", approvalId: null, taskId: task.id, employeeId: emp.id, to: ["ana@client.co.id"] });
  });

  it("an SMTP error marks the row failed with the error (and the approval FAILED)", async () => {
    const { ws, a } = await approvedEmail();
    mailModule.sendMail.mockRejectedValueOnce(new Error("550 mailbox unavailable"));
    await executeApproval(a.id);
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({ status: "failed", error: "550 mailbox unavailable", sentAt: null });
    expect(events().filter((e) => e.type === "outbox.updated").map((e) => (e as { status: string }).status)).toEqual(["sending", "failed"]);
  });

  it("SMTP not configured: logged as a failed row", async () => {
    const { ws, a } = await approvedEmail();
    await db.delete(credentials).where(eq(credentials.workspaceId, ws.id));
    await executeApproval(a.id);
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({ status: "failed", trigger: "approval", error: expect.stringMatching(/SMTP is not configured/) });
    expect(transport.mails).toHaveLength(0);
  });

  it("paused: nothing is sent, the attempt is a failed row with the policy error", async () => {
    const { ws, a } = await approvedEmail({ settings: { email: { paused: true } } });
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(0);
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({ status: "failed", error: "Outgoing email is paused (Settings → Email).", to: ["original@client.co.id"], subject: "Original" });
  });

  it("the daily limit counts today's sent/sending rows in the workspace time zone", async () => {
    const ws = await makeWorkspace({ settings: { email: { dailyLimit: 2 } }, timezone: "Asia/Jakarta" });
    const emp = await makeEmployee(ws.id);
    // yesterday's mail does not count, today's failed one neither
    await db.insert(outboundEmails).values([
      { workspaceId: ws.id, kind: "email", status: "sent", trigger: "approval", payload: {}, createdAt: new Date(Date.now() - 2 * 86_400_000) },
      { workspaceId: ws.id, kind: "email", status: "failed", trigger: "approval", payload: {} },
      { workspaceId: ws.id, kind: "email", status: "sent", trigger: "approval", payload: {} },
    ]);
    const first = await makeApproval(ws.id, null, emp.id, { status: "APPROVED" });
    const second = await makeApproval(ws.id, null, emp.id, { status: "APPROVED" });
    await executeApproval(first.id);
    await executeApproval(second.id);
    expect(transport.mails).toHaveLength(1);
    const [latest] = await rows(ws.id);
    expect(latest).toMatchObject({ status: "failed", approvalId: second.id, error: "Daily email limit reached (2 per day)." });
  });
});

describe("outbox resend", () => {
  async function failedRow() {
    const { ws, emp, task, a } = await approvedEmail();
    mailModule.sendMail.mockRejectedValueOnce(new Error("timeout"));
    await executeApproval(a.id);
    const [row] = await rows(ws.id);
    expect(row!.status).toBe("failed");
    return { ws, emp, task, a, row: row! };
  }

  it("sends the stored payload again as a new row (trigger resend, resendOf, createdBy) and audits it", async () => {
    const { ws, a, task, row } = await failedRow();
    const u = await user();
    const r = await resendOutbound(row.id, ws.id, u.id);
    expect(r?.ok).toBe(true);
    expect(transport.mails).toHaveLength(1); // the rejected first attempt is not recorded by the mock
    const [latest] = await rows(ws.id);
    expect(latest).toMatchObject({ status: "sent", trigger: "resend", resendOf: row.id, createdBy: u.id, approvalId: a.id, taskId: task.id, to: row.to, subject: row.subject });
    expect(latest!.payload).toEqual(row.payload);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "outbox.resent")));
    expect(entry).toMatchObject({ actorUserId: u.id, targetId: latest!.id, details: expect.objectContaining({ resendOf: row.id, ok: true }) });
  });

  it("is idempotent: a retried job (or a second click) sends only once", async () => {
    const { ws, row } = await failedRow();
    const u = await user();
    await Promise.all([resendOutbound(row.id, ws.id, u.id), resendOutbound(row.id, ws.id, u.id)]);
    await resendOutbound(row.id, ws.id, u.id);
    expect(transport.mails).toHaveLength(1);
    expect(await rows(ws.id)).toHaveLength(2);
  });

  it("only a failed row can be resent; another workspace's row is not found", async () => {
    const { ws, a } = await approvedEmail();
    await executeApproval(a.id);
    const [sent] = await rows(ws.id);
    const u = await user();
    expect(await resendOutbound(sent!.id, ws.id, u.id)).toBeNull();
    const other = await makeWorkspace();
    expect(await resendOutbound(sent!.id, other.id, u.id)).toBeNull();
    expect(transport.mails).toHaveLength(1);
  });

  it("the kill switch and the policy still apply: logged as a failed resend row", async () => {
    const { ws, row } = await failedRow();
    const u = await user();
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, ws.id));
    const r = await resendOutbound(row.id, ws.id, u.id);
    expect(r).toMatchObject({ ok: false, summary: expect.stringMatching(/Kill switch/) });
    const [latest] = await rows(ws.id);
    expect(latest).toMatchObject({ status: "failed", trigger: "resend", resendOf: row.id });
    expect(transport.mails).toHaveLength(0);
  });
});

describe("outbox: a sent mail is never reported as failed", () => {
  it("a publish that throws (before or after SMTP) changes nothing: the mail goes once, the row is sent, the result ok", async () => {
    const { ws, a } = await approvedEmail();
    redisModule.publish.mockRejectedValueOnce(new Error("redis down")).mockRejectedValueOnce(new Error("redis down"));
    await executeApproval(a.id);
    expect(transport.mails).toHaveLength(1);
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({ status: "sent", messageId: "<mock-1@test>" });
    const [done] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(done).toMatchObject({ status: "EXECUTED", executionResult: expect.objectContaining({ ok: true }) });
  });

  it("the sent update failing after SMTP accepted the mail still reports ok (retried, then left for the reaper)", async () => {
    const ws = await makeWorkspace();
    // db is a lazy proxy: spy on the real instance behind it
    const update = vi.spyOn(getDb(), "update").mockImplementation(() => {
      throw new Error("db connection lost");
    });
    try {
      const r = await sendEmailPayload(ws.id, emailPayloadSchema.parse({ to: ["ana@client.co.id"], subject: "Hi", body: "Hello" }), { trigger: "approval" });
      expect(r.ok).toBe(true);
      expect(update).toHaveBeenCalledTimes(3);
    } finally {
      update.mockRestore();
    }
    expect(transport.mails).toHaveLength(1);
    const [row] = await rows(ws.id);
    expect(row!.status).toBe("sending");
  });

  it("SMTP only gets validated bare addresses; a payload that skipped validation is refused as a failed row", async () => {
    const ws = await makeWorkspace();
    const ok = await sendEmailPayload(ws.id, emailPayloadSchema.parse({ to: ["Ana <Ana@Client.co.id>"], cc: ["Budi <budi@client.co.id>"], subject: "Hi", body: "Hello" }), { trigger: "approval" });
    expect(ok.ok).toBe(true);
    expect(transport.mails[0]!.mail).toMatchObject({ to: ["ana@client.co.id"], cc: ["budi@client.co.id"] });
    const bad = await sendEmailPayload(ws.id, { to: ["evil@x.com, <ok@client.co.id>"], cc: [], subject: "Hi", body: "Hello", html: false }, { trigger: "allow_list" });
    expect(bad.ok).toBe(false);
    expect(transport.mails).toHaveLength(1);
    const [latest] = await rows(ws.id);
    expect(latest).toMatchObject({ status: "failed", error: expect.stringMatching(/Invalid recipient address/), to: ["evil@x.com, <ok@client.co.id>"] });
  });
});

describe("outbox: client id", () => {
  it("is stored only when it names a client of this workspace (a bad or foreign id is null, never an insert error)", async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    const [mine] = await db.insert(clients).values({ workspaceId: ws.id, name: "Mine" }).returning();
    const [foreign] = await db.insert(clients).values({ workspaceId: other.id, name: "Foreign" }).returning();
    const send = (clientId: string) => sendEmailPayload(ws.id, emailPayloadSchema.parse({ to: ["ana@client.co.id"], subject: clientId, body: "Hello", clientId }), { trigger: "approval" });
    for (const id of [mine!.id, foreign!.id, "not-a-uuid", randomUUID()]) expect((await send(id)).ok).toBe(true);
    const byId = new Map((await rows(ws.id)).map((r) => [r.subject, r.clientId]));
    expect(byId.get(mine!.id)).toBe(mine!.id);
    expect(byId.get(foreign!.id)).toBeNull();
    expect(byId.get("not-a-uuid")).toBeNull();
    expect([...byId.values()].filter((x) => x === null)).toHaveLength(3);
  });
});

describe("outbox: rows stuck in sending", () => {
  it("the reaper fails sending rows older than 15 minutes with an interrupted warning (workspace language) and publishes", async () => {
    const ws = await makeWorkspace({ defaultLocale: "id" });
    const old = new Date(Date.now() - STUCK_SENDING_MS - 60_000);
    const [stuck] = await db.insert(outboundEmails).values({ workspaceId: ws.id, kind: "email", status: "sending", trigger: "approval", payload: {}, createdAt: old }).returning();
    const [fresh] = await db.insert(outboundEmails).values({ workspaceId: ws.id, kind: "email", status: "sending", trigger: "approval", payload: {} }).returning();
    const [sentOld] = await db.insert(outboundEmails).values({ workspaceId: ws.id, kind: "email", status: "sent", trigger: "approval", payload: {}, createdAt: old }).returning();
    const { stuckEmailsFailed } = await reapOrphanedTasks({ liveElsewhere: async () => new Set() });
    expect(stuckEmailsFailed).toContain(stuck!.id);
    expect(stuckEmailsFailed).not.toContain(fresh!.id);
    const byId = new Map((await rows(ws.id)).map((r) => [r.id, r]));
    expect(byId.get(stuck!.id)).toMatchObject({ status: "failed", error: msg("id", "outbox.interrupted") });
    expect(byId.get(fresh!.id)!.status).toBe("sending");
    expect(byId.get(sentOld!.id)!.status).toBe("sent");
    expect(events()).toContainEqual({ type: "outbox.updated", emailId: stuck!.id, status: "failed" });
    expect(msg("en", "outbox.interrupted")).toBe("Interrupted while sending — it may or may not have been delivered; check before resending.");
    // a second sweep finds nothing more
    expect(await failStuckSends()).not.toContain(stuck!.id);
  });
});
