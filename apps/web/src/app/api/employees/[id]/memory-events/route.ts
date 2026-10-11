import { and, desc, eq, sql } from "drizzle-orm";
import { db, employees, memoryEvents, users } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

type P = { id: string };

/** The memory journal of one employee, newest first (?before=<event id> for the next page, ?limit=1–100). */
export const GET = route<P>("MEMBER", async ({ session, params, req }) => {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!e) notFound("employee_not_found");
  const q = req.nextUrl.searchParams;
  const n = Number(q.get("limit"));
  const limit = Number.isFinite(n) && n >= 1 ? Math.min(100, Math.floor(n)) : 50;
  const before = q.get("before");
  const cursor = before && /^[0-9a-f-]{36}$/i.test(before) ? before : null;
  const rows = await db
    .select({
      id: memoryEvents.id,
      memoryId: memoryEvents.memoryId,
      action: memoryEvents.action,
      actor: memoryEvents.actor,
      actorUserId: memoryEvents.actorUserId,
      actorName: users.name,
      before: memoryEvents.before,
      after: memoryEvents.after,
      undoneAt: memoryEvents.undoneAt,
      createdAt: memoryEvents.createdAt,
    })
    .from(memoryEvents)
    .leftJoin(users, eq(users.id, memoryEvents.actorUserId))
    .where(
      and(
        eq(memoryEvents.employeeId, e.id),
        eq(memoryEvents.workspaceId, session.workspaceId),
        cursor
          ? sql`(${memoryEvents.createdAt}, ${memoryEvents.id}) < (select c.created_at, c.id from memory_events c where c.id = ${cursor} and c.workspace_id = ${session.workspaceId})`
          : undefined,
      ),
    )
    .orderBy(desc(memoryEvents.createdAt), desc(memoryEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { events: page, nextCursor: rows.length > limit ? page.at(-1)!.id : null };
});
