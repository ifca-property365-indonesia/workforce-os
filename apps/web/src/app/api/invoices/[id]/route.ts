import { and, eq } from "drizzle-orm";
import { audit, db, invoices } from "@wfos/db";
import { invoiceStatusPatchSchema, type InvoiceStatus } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { publish } from "@/lib/server/queue";
import { body, notFound, route } from "@/lib/server/route";
import { invoiceDto, workspaceTimeZone } from "@/lib/server/clients";

type P = { id: string };

/**
 * What a person may change by hand: mark a sent invoice paid, void a draft or a sent one, and put a paid or void
 * invoice back to sent (an undo; only for an invoice that was actually sent). Drafting is for employees only.
 */
function allowed(from: InvoiceStatus, to: InvoiceStatus, wasSent: boolean): boolean {
  if (to === "paid") return from === "sent";
  if (to === "void") return from === "draft" || from === "sent";
  if (to === "sent") return (from === "paid" || from === "void") && wasSent;
  return false;
}

export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const { status } = await body(req, invoiceStatusPatchSchema);
  const [row] = await db.select().from(invoices).where(and(eq(invoices.id, params.id), eq(invoices.workspaceId, session.workspaceId)));
  if (!row) notFound();
  const tz = await workspaceTimeZone(session.workspaceId);
  if (row.status === status) return { invoice: invoiceDto(row, tz) };
  if (!allowed(row.status, status, !!row.sentAt)) throw new HttpError(409, "Invoice status change not allowed", { code: "invoice_transition", from: row.status, to: status });
  const [r] = await db
    .update(invoices)
    .set({ status, paidAt: status === "paid" ? new Date() : null })
    .where(eq(invoices.id, row.id))
    .returning();
  await publish(session.workspaceId, { type: "invoice.updated", invoiceId: row.id, clientId: row.clientId, status });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "invoice.status_changed",
    targetType: "invoice",
    targetId: row.id,
    details: { number: row.number, from: row.status, to: status },
  });
  return { invoice: invoiceDto(r!, tz) };
});
