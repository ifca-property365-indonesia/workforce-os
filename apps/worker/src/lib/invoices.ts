import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { clients, db, invoices, workspaces } from "@wfos/db";
import {
  clientRecipientAddresses,
  formatInvoiceNumber,
  invoiceSubtotal,
  invoiceTax,
  invoiceTotal,
  parseCompanyProfile,
  type InvoicePayload,
  type InvoiceStatus,
} from "@wfos/shared";
import { invoicePdfMeta, renderInvoicePdf } from "@wfos/shared/invoice";
import { publish } from "./redis";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;
type InvoiceRow = typeof invoices.$inferSelect;

/** Attempts at the next free number before giving up (another writer took each one meanwhile). */
export const INVOICE_NUMBER_ATTEMPTS = 5;

/** Statuses after which an invoice number can never be reused. */
const FINAL: InvoiceStatus[] = ["sent", "paid", "void"];

/** The client of a payload, only within the workspace. */
export async function workspaceClient(workspaceId: string, clientId: string | null | undefined, q: Db = db) {
  if (!clientId) return undefined;
  const [c] = await q.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.workspaceId, workspaceId)));
  return c;
}

/** Lower-cased addresses on file for the client (main email + contacts), for the allow-list's clientContactsOnly rule. */
export async function clientRecipientsFor(workspaceId: string, clientId: string | null | undefined): Promise<string[] | undefined> {
  const c = await workspaceClient(workspaceId, clientId);
  return c ? clientRecipientAddresses(c) : undefined;
}

/** Who an invoice goes to when `to` is empty: the contacts that receive invoices, else the client's main email. */
export function invoiceRecipients(client: { email: string; contacts: unknown } | undefined, to: string[] = []): string[] {
  if (to.length) return to;
  if (!client) return [];
  const contacts = clientRecipientAddresses(client, "invoice");
  return contacts.length ? contacts : client.email ? [client.email] : [];
}

/**
 * "Invoice number X is already used (status sent); pick the next number", or null while the number is free (or a draft).
 * `exceptId` (the ledger row a payload sends) is exempt only while it is a draft or sent: a paid or voided invoice is
 * never emailed again ("Invoice X is void; not sent").
 */
export async function invoiceNumberRefusal(workspaceId: string, number: string, opts: { exceptId?: string | null } = {}): Promise<string | null> {
  const [row] = await db
    .select({ id: invoices.id, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.workspaceId, workspaceId), eq(invoices.number, number)));
  if (opts.exceptId) {
    const [own] = row?.id === opts.exceptId ? [row] : await db.select({ status: invoices.status }).from(invoices).where(and(eq(invoices.id, opts.exceptId), eq(invoices.workspaceId, workspaceId)));
    if (own && (own.status === "paid" || own.status === "void")) return `Invoice ${number} is ${own.status}; not sent.`;
  }
  if (!row || !FINAL.includes(row.status) || row.id === opts.exceptId) return null;
  return `Invoice number ${number} is already used (status ${row.status}); pick the next number (see list_invoices).`;
}

/** Year in the workspace's time zone. */
export function localYear(timezone: string, now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now));
}

/**
 * Next invoice number: `formatInvoiceNumber(prefix, year, seq)` with seq = 1 + the highest sequence of the ledger's
 * numbers for that prefix and year (year in the workspace's time zone). Numbers that do not follow the pattern are ignored.
 */
export async function nextInvoiceNumber(workspaceId: string, q: Db = db, now = new Date()): Promise<string> {
  const n = await numbering(q, workspaceId, now);
  return formatInvoiceNumber(n.prefix, n.year, n.seq);
}

/** The prefix, local year and next sequence of a workspace's invoice numbers. */
async function numbering(q: Db, workspaceId: string, now: Date): Promise<{ prefix: string; year: number; seq: number }> {
  const [ws] = await q.select({ timezone: workspaces.timezone, settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const prefix = parseCompanyProfile(ws?.settings).invoicePrefix;
  const year = localYear(ws?.timezone ?? "UTC", now);
  const stem = formatInvoiceNumber(prefix, year, 0).replace(/0+$/, "");
  const rows = await q
    .select({ number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.workspaceId, workspaceId), sql`starts_with(${invoices.number}, ${stem})`));
  let max = 0;
  for (const r of rows) {
    const rest = r.number.slice(stem.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return { prefix, year, seq: max + 1 };
}

/** Amount columns of a ledger row, from a payload. */
function amounts(p: Pick<InvoicePayload, "lines" | "currency" | "taxPercent">) {
  return { subtotal: invoiceSubtotal(p), tax: invoiceTax(p), total: invoiceTotal(p), taxPercent: p.taxPercent ?? 0 };
}

async function published(row: InvoiceRow | undefined): Promise<InvoiceRow | undefined> {
  if (row) await publish(row.workspaceId, { type: "invoice.updated", invoiceId: row.id, clientId: row.clientId, status: row.status });
  return row;
}

/**
 * draft_invoice: insert a draft under its number, or update the draft already there. A number already sent, paid or
 * voided is refused (returns the refusal text; nothing changes).
 */
export async function upsertDraftInvoice(workspaceId: string, p: InvoicePayload, extra: { taskId?: string | null } = {}): Promise<{ row?: InvoiceRow; refusal?: string }> {
  const changes = {
    clientId: p.clientId,
    projectId: p.projectId ?? null,
    currency: p.currency,
    lines: p.lines,
    ...amounts(p),
    dueDate: isoDate(p.dueDate),
    notes: p.notes,
    taskId: extra.taskId ?? null,
  };
  const [row] = await db
    .insert(invoices)
    .values({ ...changes, workspaceId, number: p.invoiceNumber, status: "draft" })
    .onConflictDoUpdate({ target: [invoices.workspaceId, invoices.number], set: { ...changes, updatedAt: new Date() }, setWhere: eq(invoices.status, "draft") })
    .returning();
  if (!row) return { refusal: (await invoiceNumberRefusal(workspaceId, p.invoiceNumber)) ?? `Invoice number ${p.invoiceNumber} is already used; pick the next number.` };
  return { row: await published(row) };
}

/**
 * A send_invoice that went out: the ledger row becomes `sent` (the recurring row by payload.invoiceId, else the row with
 * that number, created when missing). A row already paid or voided is left alone.
 */
export async function markInvoiceSent(
  workspaceId: string,
  p: InvoicePayload,
  sent: { emailId: string; approvalId?: string | null; taskId?: string | null },
): Promise<InvoiceRow | undefined> {
  const now = new Date();
  const mark = { status: "sent" as const, sentAt: now, emailId: sent.emailId, approvalId: sent.approvalId ?? null, updatedAt: now, ...(sent.taskId ? { taskId: sent.taskId } : {}) };
  // what was actually emailed (the approver may have edited lines or the due date)
  const content = { lines: p.lines, currency: p.currency, ...amounts(p), dueDate: isoDate(p.dueDate), notes: p.notes, ...(p.projectId ? { projectId: p.projectId } : {}) };
  if (p.invoiceId) {
    const [row] = await db
      .update(invoices)
      .set({ ...content, ...mark, number: p.invoiceNumber })
      .where(and(eq(invoices.id, p.invoiceId), eq(invoices.workspaceId, workspaceId), inArray(invoices.status, ["draft", "sent"])))
      .returning();
    if (row) return published(row);
  }
  const [row] = await db
    .insert(invoices)
    .values({ workspaceId, clientId: p.clientId, number: p.invoiceNumber, ...content, ...mark, taskId: sent.taskId ?? null })
    .onConflictDoUpdate({ target: [invoices.workspaceId, invoices.number], set: { ...content, ...mark }, setWhere: inArray(invoices.status, ["draft", "sent"]) })
    .returning();
  return published(row);
}

/**
 * Insert a ledger row under the next free number: on a number taken meanwhile (unique index) the next one is tried, up
 * to INVOICE_NUMBER_ATTEMPTS. Returns undefined when the row conflicts on another unique index (a recurring billing's
 * period already invoiced).
 */
export async function insertWithNextNumber(
  q: Db,
  workspaceId: string,
  values: Omit<typeof invoices.$inferInsert, "workspaceId" | "number">,
  now = new Date(),
): Promise<InvoiceRow | undefined> {
  const n = await numbering(q, workspaceId, now);
  for (let i = 0; i < INVOICE_NUMBER_ATTEMPTS; i++) {
    const number = formatInvoiceNumber(n.prefix, n.year, n.seq + i);
    const [row] = await q.insert(invoices).values({ ...values, workspaceId, number }).onConflictDoNothing().returning();
    if (row) return row;
    if (values.recurringId && values.period) {
      const [dup] = await q
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.recurringId, values.recurringId), eq(invoices.period, values.period)));
      if (dup) return undefined;
    }
  }
  throw new Error(`No free invoice number after ${INVOICE_NUMBER_ATTEMPTS} attempts`);
}

/** The ledger for list_invoices: newest first. */
export async function listInvoices(workspaceId: string, f: { clientId?: string; status?: InvoiceStatus; limit?: number }) {
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.workspaceId, workspaceId), f.clientId ? eq(invoices.clientId, f.clientId) : undefined, f.status ? eq(invoices.status, f.status) : undefined))
    .orderBy(desc(invoices.createdAt))
    .limit(Math.min(f.limit ?? 20, 50));
}

/** The invoice PDF exactly as it is attached to the email (company profile and the client's legal details). */
export async function invoiceAttachment(workspaceId: string, p: InvoicePayload, draft: boolean) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const client = await workspaceClient(workspaceId, p.clientId);
  const pdf = await renderInvoicePdf(p, invoicePdfMeta(ws, client, draft));
  return { pdf: Buffer.from(pdf), client, locale: ws?.defaultLocale ?? null };
}

/** YYYY-MM-DD when the due date is one (the date column), else null (free text stays on the PDF only). */
function isoDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}
