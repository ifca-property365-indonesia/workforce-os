import "server-only";
import { and, count, desc, eq, getTableColumns, gte, inArray, sql, type SQL } from "drizzle-orm";
import { approvals, clients, db, employees, outboundEmails, workspaces } from "@wfos/db";
import {
  normalizeEmail,
  OUTBOUND_EMAIL_KINDS,
  parseContacts,
  parseEmailPolicy,
  type ApprovalStatus,
  type OutboundEmailKind,
  type OutboundEmailStatus,
  type OutboxStatus,
} from "@wfos/shared";
import { OUTBOX_STATUSES, type OutboxItem, type OutboxStats } from "@/lib/outbox";

export type { OutboxItem, OutboxStats };

const OUTBOUND_STATUSES: readonly OutboundEmailStatus[] = ["sending", "sent", "failed"];
const EMAIL_TOOLS = ["send_email", "send_invoice"] as const;
const APPROVAL_PREFIX = "approval:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** approvals shown in the outbox, and what they show as (APPROVED/EXECUTING only until the worker writes its row) */
const APPROVAL_STATUS: Partial<Record<ApprovalStatus, OutboxStatus>> = {
  PENDING: "pending_approval",
  REJECTED: "rejected",
  EXPIRED: "expired",
  APPROVED: "sending",
  EXECUTING: "sending",
};

export interface OutboxFilter {
  status?: OutboxStatus[];
  kind?: OutboundEmailKind;
  clientId?: string;
  limit?: number;
}

export function parseOutboxFilter(sp: URLSearchParams): OutboxFilter {
  const status = sp
    .get("status")
    ?.split(",")
    .filter((s): s is OutboxStatus => (OUTBOX_STATUSES as readonly string[]).includes(s));
  const kind = sp.get("kind");
  const clientId = sp.get("clientId");
  const limit = Number(sp.get("limit") ?? 100);
  return {
    status: status?.length ? status : undefined,
    kind: (OUTBOUND_EMAIL_KINDS as readonly string[]).includes(kind ?? "") ? (kind as OutboundEmailKind) : undefined,
    clientId: clientId && UUID.test(clientId) ? clientId : undefined,
    limit: Number.isFinite(limit) ? Math.min(300, Math.max(1, Math.floor(limit))) : 100,
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

type ClientRow = { id: string; name: string; email: string; contacts: unknown };
type Known = { contactName?: string; role?: string };

/** address → who it is, for one client (its main email and contacts) */
function directory(list: ClientRow[]): Map<string, Known> {
  const out = new Map<string, Known>();
  for (const c of list) {
    for (const p of parseContacts(c.contacts)) {
      if (!p.email) continue;
      const key = normalizeEmail(p.email);
      if (!out.has(key) || !out.get(key)!.role) out.set(key, { contactName: p.name || undefined, role: p.role || undefined });
    }
    if (c.email) {
      const key = normalizeEmail(c.email);
      if (!out.has(key)) out.set(key, { contactName: c.name });
    }
  }
  return out;
}

class Annotator {
  private all: Map<string, Known> | null = null;
  private per = new Map<string, Map<string, Known>>();
  readonly byId: Map<string, ClientRow>;
  constructor(private rows: ClientRow[]) {
    this.byId = new Map(rows.map((c) => [c.id, c]));
  }
  annotate(addresses: string[], clientId: string | null): OutboxItem["recipients"] {
    let dir: Map<string, Known>;
    if (clientId && this.byId.has(clientId)) {
      dir = this.per.get(clientId) ?? directory([this.byId.get(clientId)!]);
      this.per.set(clientId, dir);
    } else {
      this.all ??= directory(this.rows);
      dir = this.all;
    }
    const seen = new Set<string>();
    const out: OutboxItem["recipients"] = [];
    for (const raw of addresses) {
      const email = normalizeEmail(raw);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const k = dir.get(email);
      out.push(k ? { email, known: true, ...k } : { email, known: false });
    }
    return out;
  }
}

async function annotator(workspaceId: string) {
  const rows = await db.select({ id: clients.id, name: clients.name, email: clients.email, contacts: clients.contacts }).from(clients).where(eq(clients.workspaceId, workspaceId));
  return new Annotator(rows);
}

type OutboundRow = typeof outboundEmails.$inferSelect & { employeeName: string | null };
type ApprovalRow = typeof approvals.$inferSelect & { employeeName: string | null };

function fromOutbound(r: OutboundRow, ann: Annotator, resentAs: Map<string, string>): OutboxItem {
  const client = r.clientId ? ann.byId.get(r.clientId) : undefined;
  return {
    id: r.id,
    source: "email",
    approvalId: r.approvalId,
    kind: r.kind,
    status: r.status,
    trigger: r.trigger,
    to: r.to,
    cc: r.cc,
    subject: r.subject,
    body: r.body,
    attachments: r.attachments.map((a) => ({ filename: a.filename, size: a.size })),
    error: r.error,
    employee: r.employeeId ? { id: r.employeeId, name: r.employeeName ?? "" } : null,
    taskId: r.taskId,
    client: client ? { id: client.id, name: client.name } : null,
    recipients: ann.annotate([...r.to, ...r.cc], client?.id ?? null),
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    resendOf: r.resendOf,
    resentAs: resentAs.get(r.id) ?? null,
  };
}

function fromApproval(a: ApprovalRow, ann: Annotator): OutboxItem {
  const p = (a.editedPayload ?? a.payload) as Record<string, unknown>;
  const kind: OutboundEmailKind = a.toolName === "send_invoice" ? "invoice" : "email";
  const clientId = str(p.clientId);
  const client = clientId ? ann.byId.get(clientId) : undefined;
  const to = strings(p.to);
  const cc = strings(p.cc);
  const number = str(p.invoiceNumber);
  return {
    id: `${APPROVAL_PREFIX}${a.id}`,
    source: "approval",
    approvalId: a.id,
    kind,
    status: APPROVAL_STATUS[a.status] ?? "pending_approval",
    trigger: null,
    to,
    cc,
    subject: str(p.subject) || (kind === "invoice" ? number : a.title),
    body: str(p.body),
    // the invoice PDF is rendered at send time: its size is not known yet
    attachments: kind === "invoice" && number ? [{ filename: `${number}.pdf`, size: 0 }] : [],
    error: a.status === "REJECTED" ? a.feedback : null,
    employee: a.employeeId ? { id: a.employeeId, name: a.employeeName ?? "" } : null,
    taskId: a.taskId,
    client: client ? { id: client.id, name: client.name } : null,
    recipients: ann.annotate([...to, ...cc], client?.id ?? null),
    createdAt: a.createdAt.toISOString(),
    sentAt: null,
    resendOf: null,
    resentAs: null,
  };
}

/** approvals for email tools that the outbox shows: no outbound row yet (once the worker writes one, that row stands for it) */
function approvalConds(workspaceId: string, statuses: ApprovalStatus[]): SQL[] {
  return [
    eq(approvals.workspaceId, workspaceId),
    inArray(approvals.toolName, [...EMAIL_TOOLS]),
    inArray(approvals.status, statuses),
    sql`not exists (select 1 from ${outboundEmails} o where o.approval_id = ${approvals.id})`,
  ];
}

/** failed attempt id → the attempt that resent it, for the given rows */
async function resends(workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: outboundEmails.id, resendOf: outboundEmails.resendOf })
    .from(outboundEmails)
    .where(and(eq(outboundEmails.workspaceId, workspaceId), inArray(outboundEmails.resendOf, ids)))
    .orderBy(desc(outboundEmails.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.resendOf && !out.has(r.resendOf)) out.set(r.resendOf, r.id);
  return out;
}

const outboundSelect = { ...getTableColumns(outboundEmails), employeeName: employees.name };
const approvalSelect = { ...getTableColumns(approvals), employeeName: employees.name };

export async function listOutbox(workspaceId: string, f: OutboxFilter): Promise<OutboxItem[]> {
  const limit = f.limit ?? 100;
  const wanted = (s: OutboxStatus) => !f.status || f.status.includes(s);
  const outStatuses = OUTBOUND_STATUSES.filter(wanted);
  const apprStatuses = (Object.keys(APPROVAL_STATUS) as ApprovalStatus[]).filter((s) => wanted(APPROVAL_STATUS[s]!));
  const ann = await annotator(workspaceId);

  const outRows: OutboundRow[] = [];
  if (outStatuses.length) {
    const conds: SQL[] = [eq(outboundEmails.workspaceId, workspaceId), inArray(outboundEmails.status, outStatuses)];
    if (f.kind) conds.push(eq(outboundEmails.kind, f.kind));
    if (f.clientId) conds.push(eq(outboundEmails.clientId, f.clientId));
    outRows.push(
      ...(await db
        .select(outboundSelect)
        .from(outboundEmails)
        .leftJoin(employees, eq(employees.id, outboundEmails.employeeId))
        .where(and(...conds))
        .orderBy(desc(outboundEmails.createdAt))
        .limit(limit)),
    );
  }

  const apprRows: ApprovalRow[] = [];
  if (apprStatuses.length) {
    const conds = approvalConds(workspaceId, apprStatuses);
    if (f.kind) conds.push(eq(approvals.toolName, f.kind === "invoice" ? "send_invoice" : "send_email"));
    if (f.clientId) conds.push(sql`coalesce(${approvals.editedPayload}, ${approvals.payload}) ->> 'clientId' = ${f.clientId}`);
    apprRows.push(
      ...(await db
        .select(approvalSelect)
        .from(approvals)
        .leftJoin(employees, eq(employees.id, approvals.employeeId))
        .where(and(...conds))
        .orderBy(desc(approvals.createdAt))
        .limit(limit)),
    );
  }

  const resentAs = await resends(workspaceId, outRows.filter((r) => r.status === "failed").map((r) => r.id));
  return [...outRows.map((r) => fromOutbound(r, ann, resentAs)), ...apprRows.map((a) => fromApproval(a, ann))]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/** One outbox line by its id ("<uuid>" or "approval:<uuid>"); null when it is not this workspace's. */
export async function getOutboxItem(workspaceId: string, id: string): Promise<OutboxItem | null> {
  const isApproval = id.startsWith(APPROVAL_PREFIX);
  const raw = isApproval ? id.slice(APPROVAL_PREFIX.length) : id;
  if (!UUID.test(raw)) return null;
  const ann = await annotator(workspaceId);
  if (!isApproval) {
    const [r] = await db
      .select(outboundSelect)
      .from(outboundEmails)
      .leftJoin(employees, eq(employees.id, outboundEmails.employeeId))
      .where(and(eq(outboundEmails.id, raw), eq(outboundEmails.workspaceId, workspaceId)));
    return r ? fromOutbound(r, ann, await resends(workspaceId, [r.id])) : null;
  }
  const [a] = await db
    .select(approvalSelect)
    .from(approvals)
    .leftJoin(employees, eq(employees.id, approvals.employeeId))
    .where(and(eq(approvals.id, raw), ...approvalConds(workspaceId, Object.keys(APPROVAL_STATUS) as ApprovalStatus[])));
  return a ? fromApproval(a, ann) : null;
}

/** Today's numbers (since local midnight in the workspace's time zone, like the worker's daily limit) and the policy. */
export async function outboxStats(workspaceId: string): Promise<OutboxStats> {
  const [ws] = await db.select({ settings: workspaces.settings, timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const policy = parseEmailPolicy(ws?.settings);
  const tz = ws?.timezone ?? "UTC";
  const midnight = sql`(date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`;
  const [byStatus, [pending]] = await Promise.all([
    db
      .select({ status: outboundEmails.status, n: count() })
      .from(outboundEmails)
      .where(and(eq(outboundEmails.workspaceId, workspaceId), gte(outboundEmails.createdAt, midnight)))
      .groupBy(outboundEmails.status),
    db
      .select({ n: count() })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), inArray(approvals.toolName, [...EMAIL_TOOLS]), eq(approvals.status, "PENDING"))),
  ]);
  const n = (s: OutboundEmailStatus) => byStatus.find((r) => r.status === s)?.n ?? 0;
  return { sentToday: n("sent"), failedToday: n("failed"), pending: pending?.n ?? 0, dailyLimit: policy.dailyLimit, paused: policy.paused };
}
