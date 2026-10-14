import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { audit, clients, db, invoices, outboundEmails, recurringBillings, tasks } from "@wfos/db";
import { clientInputSchema, parseContacts } from "@wfos/shared";
import { todayIn } from "@wfos/shared/health";
import { notFound, patchBody, route } from "@/lib/server/route";
import { EMPTY_BILLING, assertClientCodeFree, billingSummaries, clientCodeConflict, invoiceDto, projectsWithHealth, workspaceTimeZone } from "@/lib/server/clients";

type P = { id: string };

const HISTORY_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One client with everything its page shows: projects and health, recurring billing, the invoice ledger and history. */
export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const ws = session.workspaceId;
  if (!UUID.test(params.id)) notFound();
  const [c] = await db.select().from(clients).where(and(eq(clients.id, params.id), eq(clients.workspaceId, ws)));
  if (!c) notFound();
  const tz = await workspaceTimeZone(ws);
  const today = todayIn(tz);
  const [projects, billing, recurring, ledger, taskRows, emails, running] = await Promise.all([
    projectsWithHealth(ws, tz, c.id),
    billingSummaries(ws, tz, c.id),
    db.select().from(recurringBillings).where(and(eq(recurringBillings.workspaceId, ws), eq(recurringBillings.clientId, c.id))).orderBy(asc(recurringBillings.createdAt)),
    db.select().from(invoices).where(and(eq(invoices.workspaceId, ws), eq(invoices.clientId, c.id))).orderBy(desc(invoices.createdAt)),
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.clientId, c.id)))
      .orderBy(desc(tasks.updatedAt))
      .limit(HISTORY_LIMIT),
    db
      .select({ id: outboundEmails.id, kind: outboundEmails.kind, subject: outboundEmails.subject, status: outboundEmails.status, to: outboundEmails.to, error: outboundEmails.error, createdAt: outboundEmails.createdAt, sentAt: outboundEmails.sentAt })
      .from(outboundEmails)
      .where(and(eq(outboundEmails.workspaceId, ws), eq(outboundEmails.clientId, c.id)))
      .orderBy(desc(outboundEmails.createdAt))
      .limit(HISTORY_LIMIT),
    // work in progress for this client: queued, running or waiting on a decision
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, assigneeId: tasks.assigneeId, teamId: tasks.teamId, projectId: tasks.projectId, parentTaskId: tasks.parentTaskId, progress: tasks.progress, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws), eq(tasks.clientId, c.id), inArray(tasks.status, ["QUEUED", "RUNNING", "AWAITING_APPROVAL"])))
      .orderBy(desc(tasks.updatedAt))
      .limit(HISTORY_LIMIT),
  ]);
  const inv = ledger.map((r) => invoiceDto(r, tz, today));
  return {
    timezone: tz,
    client: { ...c, contacts: parseContacts(c.contacts), ...(billing.get(c.id) ?? EMPTY_BILLING) },
    projects,
    recurring,
    invoices: inv,
    running,
    history: {
      tasks: taskRows,
      emails,
      invoices: inv.slice(0, HISTORY_LIMIT).map((r) => ({ id: r.id, number: r.number, status: r.status, total: r.total, currency: r.currency, createdAt: r.createdAt, sentAt: r.sentAt, paidAt: r.paidAt })),
    },
  };
});

export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await patchBody(req, clientInputSchema.partial());
  if (!UUID.test(params.id)) notFound();
  await assertClientCodeFree(session.workspaceId, input.code, params.id);
  const [c] = await db
    .update(clients)
    .set(input)
    .where(and(eq(clients.id, params.id), eq(clients.workspaceId, session.workspaceId)))
    .returning()
    .catch((e) => clientCodeConflict(e, input.code));
  if (!c) notFound();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.updated", targetType: "client", targetId: c.id, details: input });
  return { client: { ...c, contacts: parseContacts(c.contacts) } };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  await db.delete(clients).where(and(eq(clients.id, params.id), eq(clients.workspaceId, session.workspaceId)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.deleted", targetType: "client", targetId: params.id });
  return { ok: true };
});
