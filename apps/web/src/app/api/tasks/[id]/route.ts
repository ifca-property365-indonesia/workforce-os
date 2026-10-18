import { and, asc, eq, inArray } from "drizzle-orm";
import { agentMessages, approvals, db, employees, tasks, teams } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";
import { taskPreviews } from "@/lib/server/apps";
import { progressFromChildren } from "@/lib/server/tasks";
import { serverEnv } from "@/lib/server/env";

export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound("task_not_found");
  const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, t.id)).orderBy(asc(tasks.createdAt));
  const parent = t.parentTaskId ? (await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.id, t.parentTaskId)))[0] : null;
  // where the work came from (a handoff from another division, an approved PRD) and what it waits for
  const ws = session.workspaceId;
  const origin = t.originTaskId
    ? ((
        await db
          .select({ id: tasks.id, title: tasks.title, status: tasks.status, teamId: tasks.teamId, teamName: teams.name })
          .from(tasks)
          .leftJoin(teams, eq(teams.id, tasks.teamId))
          .where(and(eq(tasks.id, t.originTaskId), eq(tasks.workspaceId, ws)))
      )[0] ?? null)
    : null;
  const dependsOn = t.dependsOn?.length
    ? await db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(and(inArray(tasks.id, t.dependsOn), eq(tasks.workspaceId, ws)))
    : [];
  const appr = await db.select().from(approvals).where(eq(approvals.taskId, t.id)).orderBy(asc(approvals.createdAt));
  const ids = [t.id, ...children.map((c) => c.id)];
  const msgs = await db.select().from(agentMessages).where(eq(agentMessages.workspaceId, session.workspaceId)).orderBy(asc(agentMessages.createdAt));
  const emps = await db.select({ id: employees.id, name: employees.name, avatar: employees.avatar }).from(employees).where(eq(employees.workspaceId, session.workspaceId));
  return {
    task: progressFromChildren(t, children),
    children,
    parent,
    origin,
    dependsOn,
    approvals: appr,
    messages: msgs.filter((m) => m.taskId && ids.includes(m.taskId)),
    employees: emps,
    previews: await taskPreviews(session.workspaceId, t.id),
    sandboxLimitSec: serverEnv.workspaceTaskMaxHours * 3600,
  };
});
