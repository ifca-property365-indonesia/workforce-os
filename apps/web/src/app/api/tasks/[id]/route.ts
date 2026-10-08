import { and, asc, eq } from "drizzle-orm";
import { agentMessages, approvals, db, employees, tasks } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound("task_not_found");
  const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, t.id)).orderBy(asc(tasks.createdAt));
  const parent = t.parentTaskId ? (await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.id, t.parentTaskId)))[0] : null;
  const appr = await db.select().from(approvals).where(eq(approvals.taskId, t.id)).orderBy(asc(approvals.createdAt));
  const ids = [t.id, ...children.map((c) => c.id)];
  const msgs = await db.select().from(agentMessages).where(eq(agentMessages.workspaceId, session.workspaceId)).orderBy(asc(agentMessages.createdAt));
  const emps = await db.select({ id: employees.id, name: employees.name, avatar: employees.avatar }).from(employees).where(eq(employees.workspaceId, session.workspaceId));
  return { task: t, children, parent, approvals: appr, messages: msgs.filter((m) => m.taskId && ids.includes(m.taskId)), employees: emps };
});
