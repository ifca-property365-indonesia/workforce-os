import { and, desc, eq } from "drizzle-orm";
import { clients, db, invoices } from "@wfos/db";
import { INVOICE_STATUSES, type InvoiceStatus } from "@wfos/shared";
import { todayIn } from "@wfos/shared/health";
import { route } from "@/lib/server/route";
import { clientIdParam, invoiceDto, workspaceTimeZone } from "@/lib/server/clients";

const LIMIT = 200;

/** The invoice ledger, newest first: ?clientId= and ?status= narrow it. */
export const GET = route("VIEWER", async ({ session, req }) => {
  const sp = req.nextUrl.searchParams;
  const clientId = clientIdParam(sp);
  const status = sp.get("status");
  const tz = await workspaceTimeZone(session.workspaceId);
  const rows = await db
    .select({ invoice: invoices, clientName: clients.name })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(
      and(
        eq(invoices.workspaceId, session.workspaceId),
        clientId ? eq(invoices.clientId, clientId) : undefined,
        status && (INVOICE_STATUSES as readonly string[]).includes(status) ? eq(invoices.status, status as InvoiceStatus) : undefined,
      ),
    )
    .orderBy(desc(invoices.createdAt))
    .limit(LIMIT);
  const today = todayIn(tz);
  return { invoices: rows.map((r) => ({ ...invoiceDto(r.invoice, tz, today), client: { id: r.invoice.clientId, name: r.clientName } })) };
});
