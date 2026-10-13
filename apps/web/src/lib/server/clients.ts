import "server-only";
import { and, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import { clients, db, employees, invoices, nextCronRun, projects, recurringBillings, tasks, workspaces } from "@wfos/db";
import { billingCron, type BillingPeriod } from "@wfos/shared";
import { projectHealth, todayIn } from "@wfos/shared/health";
import { HttpError } from "./auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `?clientId=` filter of a list route: absent → undefined, not a UUID → 400 (never a database error). */
export function clientIdParam(sp: URLSearchParams): string | undefined {
  const raw = sp.get("clientId");
  if (!raw) return undefined;
  if (!UUID.test(raw)) throw new HttpError(400, "Unknown client", { code: "unknown_client" });
  return raw;
}

export async function workspaceTimeZone(workspaceId: string): Promise<string> {
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.tz ?? "Asia/Jakarta";
}

/** Projects of the workspace (or of one client) with their health, all date math in the workspace time zone. */
export async function projectsWithHealth(workspaceId: string, tz: string, clientId?: string) {
  const ps = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), clientId ? eq(projects.clientId, clientId) : undefined));
  if (!ps.length) return [];
  // last activity per project = latest task update on it (or the project's own update)
  const activity = await db
    .select({ projectId: tasks.projectId, at: max(tasks.updatedAt) })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), clientId ? inArray(tasks.projectId, ps.map((p) => p.id)) : isNotNull(tasks.projectId)))
    .groupBy(tasks.projectId);
  const lastTask = new Map(activity.map((a) => [a.projectId, a.at ? new Date(a.at) : null]));
  const now = new Date();
  return ps.map((p) => {
    const t = lastTask.get(p.id) ?? null;
    const last = t && t > p.updatedAt ? t : p.updatedAt;
    const done = ["done", "completed", "archived"].includes(p.status);
    return { ...p, lastActivityAt: last.toISOString(), ...projectHealth({ deadline: p.deadline, progress: p.progress, done, lastActivityAt: last, createdAt: p.createdAt }, tz, now) };
  });
}

export interface BillingSummary {
  /** active recurring billings per month, before tax (yearly counts as 1/12) */
  recurringMonthly: number;
  /** total of invoices sent and not yet paid */
  outstanding: number;
  /** how many of those are past their due date */
  overdue: number;
}

export const EMPTY_BILLING: BillingSummary = { recurringMonthly: 0, outstanding: 0, overdue: 0 };

/** Recurring and receivable totals per client: two grouped queries for the whole workspace (or one client). */
export async function billingSummaries(workspaceId: string, tz: string, clientId?: string): Promise<Map<string, BillingSummary>> {
  const today = todayIn(tz);
  const [recurring, receivable] = await Promise.all([
    db
      .select({
        clientId: recurringBillings.clientId,
        monthly: sql<number>`coalesce(sum(case when ${recurringBillings.period} = 'yearly' then ${recurringBillings.amount} / 12 else ${recurringBillings.amount} end), 0)`.mapWith(Number),
      })
      .from(recurringBillings)
      .where(and(eq(recurringBillings.workspaceId, workspaceId), eq(recurringBillings.active, true), clientId ? eq(recurringBillings.clientId, clientId) : undefined))
      .groupBy(recurringBillings.clientId),
    db
      .select({
        clientId: invoices.clientId,
        outstanding: sql<number>`coalesce(sum(${invoices.total}), 0)`.mapWith(Number),
        overdue: sql<number>`count(*) filter (where ${invoices.dueDate} < ${today})`.mapWith(Number),
      })
      .from(invoices)
      .where(and(eq(invoices.workspaceId, workspaceId), eq(invoices.status, "sent"), clientId ? eq(invoices.clientId, clientId) : undefined))
      .groupBy(invoices.clientId),
  ]);
  const out = new Map<string, BillingSummary>();
  const get = (id: string) => out.get(id) ?? (out.set(id, { ...EMPTY_BILLING }), out.get(id)!);
  for (const r of recurring) get(r.clientId).recurringMonthly = Math.round(r.monthly * 100) / 100;
  for (const r of receivable) Object.assign(get(r.clientId), { outstanding: r.outstanding, overdue: r.overdue });
  return out;
}

/** An invoice row as the API returns it: `overdue` = sent and past its due date in the workspace time zone. */
export function invoiceDto<T extends { status: string; dueDate: string | null }>(row: T, tz: string, today = todayIn(tz)) {
  return { ...row, overdue: row.status === "sent" && !!row.dueDate && row.dueDate < today };
}

/**
 * A recurring billing may only point at this workspace's client, a project of that client and an employee of this
 * workspace: ids from elsewhere are rejected as unknown.
 */
export async function assertBillingRefs(workspaceId: string, r: { clientId: string; projectId: string | null; employeeId: string | null }) {
  const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, r.clientId), eq(clients.workspaceId, workspaceId)));
  if (!c) throw new HttpError(400, "Unknown client", { code: "unknown_client" });
  if (r.projectId) {
    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, r.projectId), eq(projects.workspaceId, workspaceId), eq(projects.clientId, r.clientId)));
    if (!p) throw new HttpError(400, "Unknown project", { code: "unknown_project" });
  }
  if (r.employeeId) {
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, r.employeeId), eq(employees.workspaceId, workspaceId)));
    if (!e) throw new HttpError(400, "Unknown employee", { code: "unknown_employee" });
  }
}

/** When the scheduler should next draft this billing: 08:00 on its day in the workspace time zone. */
export function billingNextRun(r: { period: BillingPeriod; dayOfMonth: number; startMonth: number | null }, tz: string, from = new Date()): Date {
  return nextCronRun(billingCron(r), tz, from);
}
