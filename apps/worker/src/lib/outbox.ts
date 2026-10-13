import { z } from "zod";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { audit, db, outboundEmails, users, workspaces } from "@wfos/db";
import {
  emailPayloadSchema,
  invoicePayloadSchema,
  invoiceTotal,
  parseEmailPolicy,
  parseSingleAddress,
  type EmailPayload,
  type InvoicePayload,
  type OutboundEmailKind,
  type OutboundEmailTrigger,
} from "@wfos/shared";
import { sendMail, type OutgoingMail } from "@wfos/shared/mail";
import { formatMoney } from "@wfos/shared/invoice";
import { msg } from "@wfos/shared/messages";
import { errorMessage } from "./errors";
import { log } from "./logger";
import { publish } from "./redis";
import { getSmtp } from "./settings";
import { invoiceAttachment, invoiceNumberRefusal, invoiceRecipients, markInvoiceSent, workspaceClient } from "./invoices";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OutboundRow = typeof outboundEmails.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;

export const SMTP_MISSING = "SMTP is not configured for this workspace (Settings → Email).";

export interface SendResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

/** Who and what caused a send attempt (stored on the outbox row). */
export interface SendContext {
  trigger: OutboundEmailTrigger;
  taskId?: string | null;
  employeeId?: string | null;
  approvalId?: string | null;
  resendOf?: string | null;
  createdBy?: string | null;
  /**
   * Runs under the workspace's outbox lock right before the row is inserted; false = do not attempt at all (no row).
   * Lets a resend check atomically that its failed row was not resent already.
   */
  claim?: (tx: Tx) => Promise<boolean>;
  /** a reason the attempt is refused before anything else (e.g. the kill switch): logged as a failed row */
  refuse?: string | null;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function emailHtml(body: string): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.55;color:#18181b;white-space:pre-wrap">${htmlEscape(body)}</div>`;
}

/** Local midnight (workspace time zone) as a timestamptz expression. */
function localMidnight(timezone: string) {
  return sql`(date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone})`;
}

/** Why the workspace's email policy refuses one more send right now (null = allowed). Run under the outbox lock. */
export async function emailPolicyRefusal(q: Tx | typeof db, ws: Pick<Workspace, "id" | "settings" | "timezone" | "defaultLocale">): Promise<string | null> {
  const policy = parseEmailPolicy(ws.settings);
  if (policy.paused) return msg(ws.defaultLocale, "outbox.paused");
  const [r] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(outboundEmails)
    .where(and(eq(outboundEmails.workspaceId, ws.id), inArray(outboundEmails.status, ["sent", "sending"]), gte(outboundEmails.createdAt, localMidnight(ws.timezone || "UTC"))));
  if ((r?.n ?? 0) >= policy.dailyLimit) return msg(ws.defaultLocale, "outbox.dailyLimit", { limit: policy.dailyLimit });
  return null;
}

/** A `sending` row this old has no live attempt behind it (SMTP gives up after ~90s). */
export const STUCK_SENDING_MS = 15 * 60_000;

/**
 * `sending` rows older than STUCK_SENDING_MS (the worker died mid-attempt, or the `sent` update never landed) become
 * `failed` with a warning that the mail may have gone out, in the workspace language. Returns the ids changed.
 */
export async function failStuckSends(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - STUCK_SENDING_MS);
  const stuck = await db
    .select({ id: outboundEmails.id, locale: workspaces.defaultLocale })
    .from(outboundEmails)
    .innerJoin(workspaces, eq(workspaces.id, outboundEmails.workspaceId))
    .where(and(eq(outboundEmails.status, "sending"), lt(outboundEmails.createdAt, cutoff)))
    .limit(200);
  const failed: string[] = [];
  for (const s of stuck) {
    // re-checks the status: an attempt that finished meanwhile is left alone
    const [row] = await db
      .update(outboundEmails)
      .set({ status: "failed", error: msg(s.locale, "outbox.interrupted") })
      .where(and(eq(outboundEmails.id, s.id), eq(outboundEmails.status, "sending")))
      .returning();
    if (!row) continue;
    failed.push(row.id);
    await announce(row);
  }
  return failed;
}

/** What one attempt sends, or why it cannot (the preview still fills the outbox row). */
type Prepared =
  | { mail: OutgoingMail; body: string; summary: string }
  | { error: string; preview?: { to?: string[]; cc?: string[]; subject?: string; body?: string } };

interface Attempt {
  workspaceId: string;
  kind: OutboundEmailKind;
  clientId: string | null;
  payload: Record<string, unknown>;
  prepare: () => Promise<Prepared>;
}

/** Best-effort: a publish that throws never leaves a row behind or changes the outcome of an attempt. */
async function announce(row: OutboundRow): Promise<void> {
  try {
    await publish(row.workspaceId, { type: "outbox.updated", emailId: row.id, status: row.status });
  } catch (e) {
    log.warn({ err: e, emailId: row.id }, "outbox.updated not published");
  }
}

/** Times the `sent` update is tried after SMTP accepted the mail. */
const MARK_SENT_ATTEMPTS = 3;

/** The row of a mail SMTP accepted becomes `sent`; retried, then logged (the reaper reports it as interrupted). */
async function markSent(rowId: string, messageId: string): Promise<OutboundRow | undefined> {
  for (let i = 1; i <= MARK_SENT_ATTEMPTS; i++) {
    try {
      const [sent] = await db.update(outboundEmails).set({ status: "sent", messageId, sentAt: new Date() }).where(eq(outboundEmails.id, rowId)).returning();
      return sent;
    } catch (e) {
      if (i === MARK_SENT_ATTEMPTS) log.error({ err: e, emailId: rowId, messageId }, "outbox: mail sent but the row could not be marked sent");
      else await new Promise((r) => setTimeout(r, 200 * i));
    }
  }
  return undefined;
}

/** Every recipient as one bare, validated address; null when any of them is not exactly one address. */
function validatedAddresses(list: string[]): string[] | null {
  const out = list.map(parseSingleAddress);
  return out.every((x): x is string => !!x) ? out : null;
}

/** The payload's client id when it names a client of this workspace, else null (a bad id never breaks the insert). */
async function resolveClientId(workspaceId: string, clientId: string | null | undefined): Promise<string | null> {
  if (!clientId || !z.uuid().safeParse(clientId).success) return null;
  try {
    return (await workspaceClient(workspaceId, clientId))?.id ?? null;
  } catch (e) {
    log.warn({ err: e, workspaceId }, "outbox: client lookup failed");
    return null;
  }
}

/**
 * One send attempt, logged in the outbox: the row is inserted (`sending`) before SMTP is called, then set to `sent` or
 * `failed`. An attempt refused before SMTP (not configured, policy, nothing to send) is inserted as `failed` with the
 * reason so people see it. Inserts are serialised per workspace (advisory lock) so the daily limit holds under concurrency.
 */
async function attempt(a: Attempt, ctx: SendContext): Promise<SendResult & { row?: OutboundRow }> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId));
  if (!ws) return { ok: false, summary: "Workspace not found" };
  const smtp = await getSmtp(a.workspaceId);
  let prepared: Prepared;
  if (ctx.refuse) prepared = { error: ctx.refuse };
  else if (!smtp) prepared = { error: SMTP_MISSING };
  else {
    try {
      prepared = await a.prepare();
    } catch (e) {
      prepared = { error: errorMessage(e) };
    }
  }
  const preview = "mail" in prepared ? { to: prepared.mail.to, cc: prepared.mail.cc ?? [], subject: prepared.mail.subject, body: prepared.body } : (prepared.preview ?? {});
  const attachments = "mail" in prepared ? (prepared.mail.attachments ?? []).map((x) => ({ filename: x.filename, size: x.content.length, contentType: x.contentType })) : [];

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`outbox:${ws.id}`}))`);
    if (ctx.claim && !(await ctx.claim(tx))) return null;
    const error = "error" in prepared ? prepared.error : await emailPolicyRefusal(tx, ws);
    const [r] = await tx
      .insert(outboundEmails)
      .values({
        workspaceId: ws.id,
        kind: a.kind,
        status: error ? "failed" : "sending",
        trigger: ctx.trigger,
        approvalId: ctx.approvalId ?? null,
        taskId: ctx.taskId ?? null,
        employeeId: ctx.employeeId ?? null,
        clientId: a.clientId,
        to: preview.to ?? [],
        cc: preview.cc ?? [],
        subject: preview.subject ?? "",
        body: preview.body ?? "",
        attachments,
        payload: a.payload,
        error,
        resendOf: ctx.resendOf ?? null,
        createdBy: ctx.createdBy ?? null,
      })
      .returning();
    return r!;
  });
  if (!row) return { ok: false, summary: "Already resent." };
  await announce(row);
  if (row.status === "failed" || !("mail" in prepared) || !smtp) return { ok: false, summary: row.error ?? "Not sent", details: { emailId: row.id }, row };

  // only sendMail decides failure: once SMTP accepted the mail, nothing after it may report a failed send (that would
  // invite a second email)
  let r: Awaited<ReturnType<typeof sendMail>>;
  try {
    r = await sendMail(smtp, prepared.mail);
  } catch (e) {
    const error = errorMessage(e);
    let failed: OutboundRow | undefined;
    try {
      [failed] = await db.update(outboundEmails).set({ status: "failed", error }).where(eq(outboundEmails.id, row.id)).returning();
    } catch (ue) {
      log.error({ err: ue, emailId: row.id }, "outbox: failed send could not be recorded");
    }
    if (failed) await announce(failed);
    return { ok: false, summary: `Email not sent: ${error}`, details: { emailId: row.id }, row: failed ?? row };
  }
  const sent = await markSent(row.id, r.messageId);
  if (sent) await announce(sent);
  return {
    ok: true,
    summary: prepared.summary,
    details: { messageId: r.messageId, accepted: r.accepted, emailId: row.id },
    row: sent ?? { ...row, status: "sent", messageId: r.messageId, sentAt: new Date() },
  };
}

/** send_email: the exact payload, logged in the outbox. */
export async function sendEmailPayload(workspaceId: string, p: EmailPayload, ctx: SendContext): Promise<SendResult> {
  return attempt(
    {
      workspaceId,
      kind: "email",
      clientId: await resolveClientId(workspaceId, p.clientId),
      payload: p,
      prepare: async () => {
        // SMTP only ever gets bare addresses that parsed as exactly one each
        const to = validatedAddresses(p.to);
        const cc = validatedAddresses(p.cc);
        if (!to?.length || !cc) return { error: "Invalid recipient address: each entry must be a single email address.", preview: { to: p.to, cc: p.cc, subject: p.subject, body: p.body } };
        return {
          mail: { to, cc, subject: p.subject, text: p.body, html: p.html ? p.body : emailHtml(p.body) },
          body: p.body,
          summary: `Email sent to ${to.join(", ")}`,
        };
      },
    },
    ctx,
  );
}

/**
 * send_invoice: renders the PDF, sends it (outbox row) and, once it went out, marks the ledger row `sent`. An empty
 * `to` goes to the client's contacts that receive invoices, else its main email. A number already sent, paid or voided
 * under another ledger row is refused (logged as failed).
 */
export async function sendInvoicePayload(workspaceId: string, p: InvoicePayload, ctx: SendContext): Promise<SendResult> {
  const r = await attempt(
    {
      workspaceId,
      kind: "invoice",
      clientId: await resolveClientId(workspaceId, p.clientId),
      payload: p,
      prepare: async () => {
        const preview = { to: p.to, subject: p.subject, body: p.body };
        const refusal = await invoiceNumberRefusal(workspaceId, p.invoiceNumber, { exceptId: p.invoiceId });
        if (refusal) return { error: refusal, preview };
        const { pdf, client, locale } = await invoiceAttachment(workspaceId, p, false);
        if (!client) return { error: "Client not found", preview };
        const recipients = invoiceRecipients(client, p.to);
        if (!recipients.length) return { error: "No recipient for invoice", preview };
        // SMTP only ever gets bare addresses that parsed as exactly one each
        const to = validatedAddresses(recipients);
        if (!to) return { error: "Invalid recipient address: each entry must be a single email address.", preview: { ...preview, to: recipients } };
        const total = formatMoney(invoiceTotal(p), p.currency, locale === "en" ? "en-US" : "id-ID");
        // defaults in the workspace language; an approved (possibly edited) subject/body is always used as-is
        const subject = p.subject || msg(locale, "invoice.subject", { number: p.invoiceNumber });
        const body = p.body || msg(locale, "invoice.body", { client: client.name || msg(locale, "invoice.client"), number: p.invoiceNumber, total, due: p.dueDate });
        return {
          mail: { to, subject, text: body, html: emailHtml(body), attachments: [{ filename: `${p.invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }] },
          body,
          summary: `Invoice ${p.invoiceNumber} (${total}) sent to ${to.join(", ")}`,
        };
      },
    },
    ctx,
  );
  if (r.ok && r.row) {
    // the email went out: a ledger failure is logged, never reported as a failed send (that would invite a second email)
    try {
      await markInvoiceSent(workspaceId, p, { emailId: r.row.id, approvalId: ctx.approvalId, taskId: ctx.taskId });
    } catch (e) {
      log.error({ err: e, workspaceId, invoice: p.invoiceNumber }, "invoice ledger update after send failed");
    }
  }
  const { row: _row, ...result } = r;
  return result;
}

/**
 * The misc `outbox_resend` job: send a failed outbox row's payload again as a new row (trigger resend, resendOf the
 * failed one). Only a failed row, and only once: a BullMQ retry (or a second click) finds the resend row and does
 * nothing. The kill switch and the email policy still apply (logged as a failed row).
 */
export async function resendOutbound(emailId: string, workspaceId: string, userId: string): Promise<SendResult | null> {
  const [orig] = await db.select().from(outboundEmails).where(and(eq(outboundEmails.id, emailId), eq(outboundEmails.workspaceId, workspaceId)));
  if (!orig) return null;
  if (orig.status !== "failed") {
    log.info({ emailId, status: orig.status }, "outbox resend skipped: not a failed email");
    return null;
  }
  const [ws] = await db.select({ killSwitch: workspaces.killSwitch }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const ctx: SendContext = {
    trigger: "resend",
    resendOf: orig.id,
    createdBy: userId,
    approvalId: orig.approvalId,
    taskId: orig.taskId,
    employeeId: orig.employeeId,
    refuse: ws?.killSwitch ? "Kill switch engaged: email not sent." : null,
    claim: async (tx) => {
      const [done] = await tx.select({ id: outboundEmails.id }).from(outboundEmails).where(eq(outboundEmails.resendOf, orig.id)).limit(1);
      return !done;
    },
  };
  let result: SendResult;
  try {
    result =
      orig.kind === "invoice"
        ? await sendInvoicePayload(workspaceId, invoicePayloadSchema.parse(orig.payload), ctx)
        : await sendEmailPayload(workspaceId, emailPayloadSchema.parse(orig.payload), ctx);
  } catch (e) {
    // a stored payload that no longer parses: nothing to retry
    log.warn({ err: e, emailId }, "outbox resend: stored payload is invalid");
    return { ok: false, summary: errorMessage(e) };
  }
  const newId = typeof result.details?.emailId === "string" ? result.details.emailId : null;
  if (!newId) return result; // already resent: nothing new to audit
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  await audit({
    workspaceId,
    actorUserId: userId,
    actorLabel: u?.email ?? "user",
    action: "outbox.resent",
    targetType: "outbound_email",
    targetId: newId,
    details: { resendOf: orig.id, kind: orig.kind, ok: result.ok, summary: result.summary.slice(0, 300) },
  });
  return result;
}
