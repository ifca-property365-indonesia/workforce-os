import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employees, tasks } from "@wfos/db";
import { body, notFound, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";

const schema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });

export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { status } = await body(req, schema);
  const [e] = await db.update(employees).set({ status }).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId))).returning();
  if (!e) notFound();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: status === "ACTIVE" ? "employee.resumed" : "employee.paused", targetType: "employee", targetId: e.id });
  await publish(session.workspaceId, { type: "employee.updated", employeeId: e.id, status });
  if (status === "ACTIVE") {
    // resume work that waited while the employee was paused
    const waiting = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.assigneeId, e.id), eq(tasks.status, "QUEUED")));
    for (const t of waiting) await q.task(t.id, session.workspaceId);
  }
  return { employee: e };
});
