import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, employees, incidents, tasks } from "@wfos/db";
import { INCIDENT_STATUSES, type IncidentStatus } from "@wfos/shared";
import { route } from "@/lib/server/route";

/** Everything that still needs attention (a lead is on it, a person was asked, or it was muted). */
const ACTIVE_INCIDENT_STATUSES: IncidentStatus[] = ["open", "handling", "escalated", "muted"];
const MAX_LIMIT = 50;

/** `?limit=` floored to a whole number and clamped to 1–50; missing or not a finite number → 50. */
function parseLimit(raw: string | null): number {
  const n = raw?.trim() ? Math.floor(Number(raw)) : NaN;
  if (!Number.isFinite(n)) return MAX_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

const employee = alias(employees, "incident_employee");
const handler = alias(employees, "incident_handler");

export const GET = route("VIEWER", async ({ session, req }) => {
  const sp = req.nextUrl.searchParams;
  const requested = sp
    .get("status")
    ?.split(",")
    .map((s) => s.trim())
    .filter((s): s is IncidentStatus => (INCIDENT_STATUSES as readonly string[]).includes(s));
  const statuses = requested?.length ? requested : ACTIVE_INCIDENT_STATUSES;
  const limit = parseLimit(sp.get("limit"));
  const ws = session.workspaceId;
  const rows = await db
    .select({
      incident: incidents,
      task: { id: tasks.id, title: tasks.title, status: tasks.status },
      employee: { id: employee.id, name: employee.name, avatar: employee.avatar },
      handler: { id: handler.id, name: handler.name, avatar: handler.avatar },
    })
    .from(incidents)
    // joined rows must belong to the same workspace, whatever ids the row carries
    .leftJoin(tasks, and(eq(tasks.id, incidents.taskId), eq(tasks.workspaceId, ws)))
    .leftJoin(employee, and(eq(employee.id, incidents.employeeId), eq(employee.workspaceId, ws)))
    .leftJoin(handler, and(eq(handler.id, incidents.handlerEmployeeId), eq(handler.workspaceId, ws)))
    .where(and(eq(incidents.workspaceId, ws), inArray(incidents.status, statuses)))
    .orderBy(desc(incidents.createdAt))
    .limit(limit);
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const [resolved] = await db
    .select({ n: count() })
    .from(incidents)
    .where(and(eq(incidents.workspaceId, ws), eq(incidents.status, "resolved"), gte(incidents.resolvedAt, since)));
  return {
    incidents: rows.map((r) => ({
      id: r.incident.id,
      kind: r.incident.kind,
      status: r.incident.status,
      summary: r.incident.summary,
      resolution: r.incident.resolution,
      routineId: r.incident.routineId,
      parentTaskId: r.incident.parentTaskId,
      createdAt: r.incident.createdAt,
      resolvedAt: r.incident.resolvedAt,
      task: r.task?.id ? r.task : null,
      employee: r.employee?.id ? r.employee : null,
      handler: r.handler?.id ? r.handler : null,
    })),
    resolved7d: resolved?.n ?? 0,
  };
});
