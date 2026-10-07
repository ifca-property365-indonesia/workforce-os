import { and, eq } from "drizzle-orm";
import { approvals, clients, db, workspaces } from "@wfos/db";
import { invoicePayloadSchema } from "@wfos/shared";
import { renderInvoicePdf } from "@wfos/shared/invoice";
import { HttpError } from "@/lib/server/auth";
import { notFound, route } from "@/lib/server/route";

/** Renders the invoice exactly as it would be attached to the email. */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [a] = await db.select().from(approvals).where(and(eq(approvals.id, params.id), eq(approvals.workspaceId, session.workspaceId)));
  if (!a) notFound();
  if (a.toolName !== "send_invoice") throw new HttpError(400, "Not an invoice approval");
  const inv = invoicePayloadSchema.parse(a.editedPayload ?? a.payload);
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId));
  const [client] = await db.select().from(clients).where(eq(clients.id, inv.clientId));
  const pdf = await renderInvoicePdf(inv, { workspaceName: ws!.name, clientName: client?.name ?? "Client", clientEmail: client?.email, draft: a.status === "PENDING" });
  return new Response(Buffer.from(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${inv.invoiceNumber}.pdf"` } });
});
