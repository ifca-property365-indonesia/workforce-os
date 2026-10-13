import { and, eq } from "drizzle-orm";
import { clients, db, invoices, workspaces } from "@wfos/db";
import type { InvoicePayload } from "@wfos/shared";
import { invoicePdfMeta, renderInvoicePdf } from "@wfos/shared/invoice";
import { notFound, route } from "@/lib/server/route";

/** A ledger invoice as PDF, with the company profile and the client's details (drafts carry a DRAFT watermark). */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [row] = await db.select().from(invoices).where(and(eq(invoices.id, params.id), eq(invoices.workspaceId, session.workspaceId)));
  if (!row) notFound();
  const [[ws], [client]] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)),
    db.select().from(clients).where(eq(clients.id, row.clientId)),
  ]);
  const inv: InvoicePayload = {
    clientId: row.clientId,
    invoiceNumber: row.number,
    currency: row.currency,
    lines: row.lines,
    taxPercent: row.taxPercent,
    dueDate: row.dueDate ?? "",
    notes: row.notes,
    to: [],
    subject: "",
    body: "",
    projectId: row.projectId,
    invoiceId: row.id,
  };
  const pdf = await renderInvoicePdf(inv, invoicePdfMeta(ws, client, row.status === "draft"));
  // the number is the filename: keep it to safe characters so the header can't be broken
  const filename = `${row.number.replace(/[^A-Za-z0-9._-]+/g, "_") || "invoice"}.pdf`;
  return new Response(Buffer.from(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"` } });
});
