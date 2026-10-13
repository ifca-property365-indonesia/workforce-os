import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, clients, db, invoices, nextCronRun, outboundEmails, recurringBillings } from "@wfos/db";
import { billingCron, type NotifyJob, type RealtimeEvent } from "@wfos/shared";
import { tickBilling } from "../src/scheduler/billing";
import { executeApproval } from "../src/runner/approvals";
import { makeEmployee, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

const events = () => transport.published.map((p) => p.ev as RealtimeEvent);
// 2026-11-01 08:00 in Jakarta (UTC+7)
const NOV_1 = new Date("2026-11-01T01:00:00Z");

async function setup(over: { client?: Partial<typeof clients.$inferInsert>; billing?: Partial<typeof recurringBillings.$inferInsert> } = {}) {
  const ws = await makeWorkspace({ timezone: "Asia/Jakarta", defaultLocale: "en", settings: { company: { invoicePrefix: "INV", defaultTaxPercent: 11 } } });
  const emp = await makeEmployee(ws.id);
  const [client] = await db
    .insert(clients)
    .values({
      workspaceId: ws.id,
      name: "Kopi Nusantara",
      email: "hello@kopi.co.id",
      currency: "IDR",
      contacts: [{ name: "Dewi", email: "ap@kopi.co.id", role: "billing", receives: { status: false, minutes: false, invoice: true } }],
      ...over.client,
    })
    .returning();
  const [billing] = await db
    .insert(recurringBillings)
    .values({ workspaceId: ws.id, clientId: client!.id, description: "Hosting & maintenance", amount: 2_000_000, taxPercent: 11, dueDays: 14, period: "monthly", dayOfMonth: 1, employeeId: emp.id, nextRunAt: new Date(NOV_1.getTime() - 60_000), ...over.billing })
    .returning();
  return { ws, emp, client: client!, billing: billing! };
}

describe("recurring billing scheduler", () => {
  it("drafts the period's invoice and raises a send_invoice approval (no task), notifies, and moves nextRunAt", async () => {
    const { ws, emp, client, billing } = await setup();
    await tickBilling(NOV_1);

    const [inv] = await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id));
    expect(inv).toMatchObject({
      number: "INV-2026-0001",
      status: "draft",
      period: "2026-11",
      recurringId: billing.id,
      clientId: client.id,
      lines: [{ description: "Hosting & maintenance — 2026-11", quantity: 1, unitPrice: 2_000_000 }],
      subtotal: 2_000_000,
      tax: 220_000,
      total: 2_220_000,
      dueDate: "2026-11-15",
    });
    const [a] = await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id));
    expect(a).toMatchObject({ toolName: "send_invoice", taskId: null, conversationId: null, employeeId: emp.id, status: "PENDING", reason: "Recurring billing: approve to email this invoice" });
    expect(a!.title).toMatch(/^Recurring invoice INV-2026-0001 — Kopi Nusantara \(.*2,220,000.*\)$/);
    expect(a!.payload).toMatchObject({ invoiceId: inv!.id, invoiceNumber: "INV-2026-0001", to: ["ap@kopi.co.id"], taxPercent: 11 });
    expect(inv!.approvalId).toBe(a!.id);

    const notify = transport.queued.find((q) => q.name === "notify")!.data as NotifyJob;
    expect(notify).toMatchObject({ notificationKind: "approval", employeeId: emp.id, approvalId: a!.id, link: `/approvals?focus=${a!.id}` });
    expect(events()).toContainEqual(expect.objectContaining({ type: "approval.created", approvalId: a!.id, taskId: null }));
    expect(events()).toContainEqual({ type: "invoice.updated", invoiceId: inv!.id, clientId: client.id, status: "draft" });

    const [b] = await db.select().from(recurringBillings).where(eq(recurringBillings.id, billing.id));
    expect(b!.lastPeriod).toBe("2026-11");
    expect(b!.nextRunAt).toEqual(nextCronRun(billingCron(billing), "Asia/Jakarta", NOV_1));
    expect(b!.nextRunAt!.toISOString()).toBe("2026-12-01T01:00:00.000Z");
  });

  it("never invoices a period twice: a second tick (or a row moved back) does nothing", async () => {
    const { ws, billing } = await setup();
    await tickBilling(NOV_1);
    await tickBilling(NOV_1);
    // someone set nextRunAt back into the same month
    await db.update(recurringBillings).set({ nextRunAt: NOV_1 }).where(eq(recurringBillings.id, billing.id));
    await tickBilling(new Date(NOV_1.getTime() + 3_600_000));
    expect(await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id))).toHaveLength(1);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(1);
    // concurrent ticks: each due row is claimed once
    await db.update(recurringBillings).set({ nextRunAt: NOV_1, lastPeriod: null }).where(eq(recurringBillings.id, billing.id));
    await db.delete(invoices).where(eq(invoices.workspaceId, ws.id));
    await Promise.all([tickBilling(NOV_1), tickBilling(NOV_1), tickBilling(NOV_1)]);
    expect(await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id))).toHaveLength(1);
  });

  it("a worker outage across a month boundary still bills the missed month, then catches up one period per tick", async () => {
    // due 2026-10-01 08:00 Jakarta, but the worker only gets to it on 2026-11-03
    const OCT_1 = new Date("2026-10-01T01:00:00Z");
    const NOV_3 = new Date("2026-11-03T03:00:00Z");
    const { ws, billing } = await setup({ billing: { nextRunAt: OCT_1 } });
    const first = await tickBilling(NOV_3);
    expect(first).toHaveLength(1); // one run per tick, even though November is due too
    let rows = await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period: "2026-10", dueDate: "2026-10-15", lines: [expect.objectContaining({ description: "Hosting & maintenance — 2026-10" })] });
    let [b] = await db.select().from(recurringBillings).where(eq(recurringBillings.id, billing.id));
    expect(b!.lastPeriod).toBe("2026-10");
    expect(b!.nextRunAt!.toISOString()).toBe(NOV_1.toISOString());

    // the next tick bills November (still due), then the schedule is back in the future
    await tickBilling(new Date(NOV_3.getTime() + 30_000));
    rows = await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id));
    expect(rows.map((r) => r.period).sort()).toEqual(["2026-10", "2026-11"]);
    expect(rows.find((r) => r.period === "2026-11")!.dueDate).toBe("2026-11-15");
    [b] = await db.select().from(recurringBillings).where(eq(recurringBillings.id, billing.id));
    expect(b!.nextRunAt!.toISOString()).toBe("2026-12-01T01:00:00.000Z");
    // nothing more is due
    expect(await tickBilling(new Date(NOV_3.getTime() + 60_000))).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(2);
  });

  it("an inactive client's period is skipped (no invoice), nextRunAt still advances", async () => {
    const { ws, billing } = await setup({ client: { status: "inactive" } });
    await tickBilling(NOV_1);
    expect(await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id))).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(0);
    const [b] = await db.select().from(recurringBillings).where(eq(recurringBillings.id, billing.id));
    expect(b!.nextRunAt!.toISOString()).toBe("2026-12-01T01:00:00.000Z");
    expect(b!.lastPeriod).toBeNull();
  });

  it("a billing not due yet, or paused, is left alone; a missing nextRunAt is filled in", async () => {
    const { ws, billing } = await setup({ billing: { nextRunAt: new Date(NOV_1.getTime() + 60_000) } });
    const [paused] = await db
      .insert(recurringBillings)
      .values({ workspaceId: ws.id, clientId: billing.clientId, description: "Paused", amount: 1, active: false, nextRunAt: new Date(NOV_1.getTime() - 60_000) })
      .returning();
    const [fresh] = await db
      .insert(recurringBillings)
      .values({ workspaceId: ws.id, clientId: billing.clientId, description: "Yearly", amount: 12, period: "yearly", startMonth: 3, dayOfMonth: 5, nextRunAt: null })
      .returning();
    await tickBilling(NOV_1);
    expect(await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id))).toHaveLength(0);
    const [p] = await db.select().from(recurringBillings).where(eq(recurringBillings.id, paused!.id));
    expect(p!.lastPeriod).toBeNull();
    const [f] = await db.select().from(recurringBillings).where(eq(recurringBillings.id, fresh!.id));
    expect(f!.nextRunAt!.toISOString()).toBe("2027-03-05T01:00:00.000Z");
  });

  it("no recipient on file: the draft is still made and the approval asks for a `to`", async () => {
    const { ws } = await setup({ client: { email: "", contacts: [] }, billing: { employeeId: null } });
    await tickBilling(NOV_1);
    expect(await db.select().from(invoices).where(eq(invoices.workspaceId, ws.id))).toHaveLength(1);
    const [a] = await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id));
    expect(a).toMatchObject({ employeeId: null, payload: expect.objectContaining({ to: [] }) });
    expect(a!.reason).toMatch(/No recipient/);
    const notify = transport.queued.find((q) => q.name === "notify")!.data as NotifyJob;
    expect(notify).toMatchObject({ employeeId: null, approvalId: a!.id });
  });

  it("explicit recipients win; once approved the invoice is emailed and its ledger row (by invoiceId) becomes sent", async () => {
    const { ws, billing } = await setup({ billing: { recipients: ["cfo@kopi.co.id"], employeeId: null } });
    await tickBilling(NOV_1);
    const [a] = await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id));
    expect(a!.payload).toMatchObject({ to: ["cfo@kopi.co.id"] });
    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    const [done] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(done!.status).toBe("EXECUTED");
    expect(transport.mails[0]!.mail.to).toEqual(["cfo@kopi.co.id"]);
    const [inv] = await db.select().from(invoices).where(eq(invoices.recurringId, billing.id));
    const [email] = await db.select().from(outboundEmails).where(eq(outboundEmails.workspaceId, ws.id));
    expect(inv).toMatchObject({ status: "sent", emailId: email!.id, approvalId: a!.id, taskId: null });
    expect(email).toMatchObject({ trigger: "approval", employeeId: null, taskId: null, kind: "invoice" });
  });
});
