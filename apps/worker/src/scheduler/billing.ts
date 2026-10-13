import { and, asc, eq, isNull, lte, notInArray } from "drizzle-orm";
import { approvals, db, employees, invoices, nextCronRun, recurringBillings, workspaces } from "@wfos/db";
import { billingCron, billingPeriodOf, invoiceSubtotal, invoiceTax, invoiceTotal, type InvoicePayload } from "@wfos/shared";
import { formatMoney } from "@wfos/shared/invoice";
import { msg } from "@wfos/shared/messages";
import { insertWithNextNumber, invoiceRecipients, workspaceClient } from "../lib/invoices";
import { log } from "../lib/logger";
import { miscQueue, publish } from "../lib/redis";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Billing = typeof recurringBillings.$inferSelect;

/** Recurring billings handled per tick (the rest wait for the next one). */
export const BILLING_BATCH = 20;
/** A billing whose run threw is tried again after this long. */
export const BILLING_RETRY_MS = 60 * 60_000;

/** Year / month / day of `now` in a time zone. */
export function localDate(timezone: string, now = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function addDays(d: { year: number; month: number; day: number }, days: number): string {
  return new Date(Date.UTC(d.year, d.month - 1, d.day + days)).toISOString().slice(0, 10);
}

/** What one billing run produced, for the side effects after commit. */
type Outcome =
  | { kind: "skipped"; billingId: string; reason: string }
  | {
      kind: "invoiced";
      billingId: string;
      workspaceId: string;
      invoice: typeof invoices.$inferSelect;
      approvalId: string;
      title: string;
      reason: string;
      locale: string | null;
      employee: { id: string; name: string; role: string } | null;
    };

/**
 * One due billing, inside the transaction that holds its row lock: covers the period its due time (nextRunAt, workspace
 * time zone) falls in, so a worker that was down across a month boundary still bills the missed month, unless it was
 * already invoiced or the client is inactive; drafts the invoice under the next number and raises the send_invoice
 * approval (no task, no chat). nextRunAt moves to the firing of the following period, which may still be due (the next
 * tick catches it up).
 */
async function runBilling(tx: Tx, r: Billing, now: Date): Promise<Outcome> {
  const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, r.workspaceId));
  const tz = ws?.timezone || "UTC";
  const due = r.nextRunAt ?? now;
  const today = localDate(tz, due);
  const period = billingPeriodOf(r.period, today);
  let next = nextCronRun(billingCron(r), tz, due);
  // a due time just before its firing (or a retry) must not land on the period being billed now
  if (billingPeriodOf(r.period, localDate(tz, next)) === period) next = nextCronRun(billingCron(r), tz, next);
  const advance = (extra: Partial<Billing> = {}) => tx.update(recurringBillings).set({ nextRunAt: next, updatedAt: new Date(), ...extra }).where(eq(recurringBillings.id, r.id));

  if (r.lastPeriod === period) {
    await advance();
    return { kind: "skipped", billingId: r.id, reason: `period ${period} already invoiced` };
  }
  const client = await workspaceClient(r.workspaceId, r.clientId, tx);
  if (!client || client.status === "inactive") {
    await advance();
    return { kind: "skipped", billingId: r.id, reason: "client inactive" };
  }

  const lines = [{ description: `${r.description} — ${period}`, quantity: 1, unitPrice: r.amount }];
  const money = { lines, currency: client.currency, taxPercent: r.taxPercent };
  // due counted from the billed period's date, not from when the worker got to it
  const dueDate = addDays(today, r.dueDays);
  const inv = await insertWithNextNumber(
    tx,
    r.workspaceId,
    {
      clientId: client.id,
      projectId: r.projectId,
      currency: client.currency,
      lines,
      subtotal: invoiceSubtotal(money),
      taxPercent: r.taxPercent,
      tax: invoiceTax(money),
      total: invoiceTotal(money),
      dueDate,
      status: "draft",
      period,
      recurringId: r.id,
    },
    now,
  );
  if (!inv) {
    // another scheduler invoiced this period meanwhile
    await advance({ lastPeriod: period });
    return { kind: "skipped", billingId: r.id, reason: `period ${period} already invoiced` };
  }

  // the requester shown on the approval: only an employee of this workspace
  const [emp] = r.employeeId
    ? await tx
        .select({ id: employees.id, name: employees.name, role: employees.role })
        .from(employees)
        .where(and(eq(employees.id, r.employeeId), eq(employees.workspaceId, r.workspaceId)))
    : [];
  const to = r.recipients.length ? r.recipients : invoiceRecipients(client);
  const payload: InvoicePayload = {
    clientId: client.id,
    invoiceNumber: inv.number,
    currency: client.currency,
    lines,
    taxPercent: r.taxPercent,
    dueDate,
    notes: "",
    to,
    subject: "",
    body: "",
    projectId: r.projectId,
    invoiceId: inv.id,
  };
  const locale = ws?.defaultLocale ?? null;
  const title = msg(locale, "billing.approvalTitle", { number: inv.number, client: client.name, total: formatMoney(inv.total, inv.currency, locale === "en" ? "en-US" : "id-ID") });
  const reason = msg(locale, to.length ? "billing.approvalReason" : "billing.approvalReasonNoRecipient");
  const [a] = await tx
    .insert(approvals)
    .values({ workspaceId: r.workspaceId, taskId: null, employeeId: emp?.id ?? null, toolName: "send_invoice", title, reason, payload, guardFindings: [] })
    .returning({ id: approvals.id });
  const [linked] = await tx.update(invoices).set({ approvalId: a!.id }).where(eq(invoices.id, inv.id)).returning();
  await advance({ lastPeriod: period });
  return { kind: "invoiced", billingId: r.id, workspaceId: r.workspaceId, invoice: linked!, approvalId: a!.id, title, reason, locale, employee: emp ?? null };
}

/** After commit: the board and the approver hear about the new draft and approval (same notify job as createApproval). */
async function announce(o: Extract<Outcome, { kind: "invoiced" }>): Promise<void> {
  await publish(o.workspaceId, { type: "invoice.updated", invoiceId: o.invoice.id, clientId: o.invoice.clientId, status: o.invoice.status });
  await publish(o.workspaceId, { type: "approval.created", approvalId: o.approvalId, taskId: null, conversationId: null, title: o.title });
  await miscQueue.add("notify", {
    kind: "notify",
    notificationKind: "approval",
    employeeId: o.employee?.id ?? null,
    workspaceId: o.workspaceId,
    subject: msg(o.locale, "notify.approvalNeeded", { title: o.title }),
    text: o.employee
      ? msg(o.locale, "notify.approvalNeededText", { employee: o.employee.name, role: o.employee.role, tool: "send_invoice", reason: o.reason })
      : `${msg(o.locale, "billing.requester")}: ${o.reason}`,
    link: `/approvals?focus=${o.approvalId}`,
    approvalId: o.approvalId,
  });
}

/**
 * Called with the routine tick (every 30s). Each due billing (active, nextRunAt reached) is claimed with a row lock
 * that other workers skip (FOR UPDATE SKIP LOCKED) and handled in that transaction, at most once per tick (a billing
 * behind by several periods catches up one period per tick); a billing that throws is retried after BILLING_RETRY_MS.
 * Active billings without nextRunAt get one.
 */
export async function tickBilling(now: Date = new Date()): Promise<Outcome[]> {
  const done: Outcome[] = [];
  const failed = new Set<string>();
  const handled: string[] = [];
  for (let i = 0; i < BILLING_BATCH; i++) {
    let claimedId: string | null = null;
    let outcome: Outcome | null;
    try {
      outcome = await db.transaction(async (tx) => {
        const [r] = await tx
          .select()
          .from(recurringBillings)
          .where(and(eq(recurringBillings.active, true), lte(recurringBillings.nextRunAt, now), handled.length ? notInArray(recurringBillings.id, handled) : undefined))
          .orderBy(asc(recurringBillings.nextRunAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!r) return null;
        claimedId = r.id;
        return runBilling(tx, r, now);
      });
    } catch (e) {
      log.error({ err: e, billingId: claimedId }, "recurring billing failed");
      if (!claimedId || failed.has(claimedId)) break;
      failed.add(claimedId);
      await db.update(recurringBillings).set({ nextRunAt: new Date(now.getTime() + BILLING_RETRY_MS) }).where(eq(recurringBillings.id, claimedId));
      continue;
    }
    if (!outcome) break;
    handled.push(outcome.billingId);
    done.push(outcome);
    if (outcome.kind === "invoiced") {
      log.info({ billingId: outcome.billingId, invoice: outcome.invoice.number }, "recurring invoice drafted");
      await announce(outcome).catch((e: unknown) => log.warn({ err: e, billingId: outcome.billingId }, "recurring invoice announce failed"));
    }
  }
  const missing = await db.select().from(recurringBillings).where(and(eq(recurringBillings.active, true), isNull(recurringBillings.nextRunAt)));
  for (const r of missing) {
    const [ws] = await db.select({ timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, r.workspaceId));
    await db.update(recurringBillings).set({ nextRunAt: nextCronRun(billingCron(r), ws?.timezone || "UTC", now) }).where(eq(recurringBillings.id, r.id));
  }
  return done;
}
