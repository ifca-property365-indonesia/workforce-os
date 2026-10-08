import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, employees, steps, tasks, teamMembers, teams, workspaceDepartments } from "@wfos/db";
import { route } from "@/lib/server/route";
import { currentLocale } from "@/i18n/locale";

/**
 * Live office snapshot: employees with their rooms (teams/departments), the task each is on and the last step of
 * that task. The page keeps it live from SSE (`step.created`, `task.updated`, `employee.updated`). Titles only:
 * no step input/output leaves the server here.
 */
export const GET = route("VIEWER", async ({ session }) => {
  const ws = session.workspaceId;
  const emps = await db
    .select({ id: employees.id, name: employees.name, avatar: employees.avatar, role: employees.role, department: employees.department, status: employees.status })
    .from(employees)
    .where(and(eq(employees.workspaceId, ws), ne(employees.status, "ARCHIVED")));
  const ids = emps.map((e) => e.id);
  const memberships = ids.length
    ? await db
        .select({ employeeId: teamMembers.employeeId, id: teams.id, name: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(and(eq(teams.workspaceId, ws), inArray(teamMembers.employeeId, ids)))
    : [];
  const active = ids.length
    ? await db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, assigneeId: tasks.assigneeId, updatedAt: tasks.updatedAt })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), inArray(tasks.status, ["RUNNING", "AWAITING_APPROVAL"]), inArray(tasks.assigneeId, ids)))
        .orderBy(desc(tasks.updatedAt))
    : [];
  // one task per employee: the most recently updated
  const taskOf = new Map<string, (typeof active)[number]>();
  for (const t of active) if (t.assigneeId && !taskOf.has(t.assigneeId)) taskOf.set(t.assigneeId, t);
  const taskIds = [...taskOf.values()].map((t) => t.id);
  const lastSteps = taskIds.length
    ? await db
        .selectDistinctOn([steps.taskId], { taskId: steps.taskId, kind: steps.kind, name: steps.name, at: steps.createdAt })
        .from(steps)
        .where(and(eq(steps.workspaceId, ws), inArray(steps.taskId, taskIds)))
        .orderBy(steps.taskId, desc(steps.createdAt))
    : [];
  const locale = await currentLocale();
  const depts = await workspaceDepartments(ws);
  return {
    departments: Object.fromEntries(depts.map((d) => [d.key, d.name[locale] ?? d.name.en])),
    employees: emps.map((e) => {
      const t = taskOf.get(e.id);
      const s = t ? lastSteps.find((x) => x.taskId === t.id) : undefined;
      return {
        ...e,
        teams: memberships.filter((m) => m.employeeId === e.id).map((m) => ({ id: m.id, name: m.name })),
        task: t ? { id: t.id, title: t.title, status: t.status } : null,
        lastStep: s ? { kind: s.kind, name: s.name, at: s.at.toISOString() } : null,
      };
    }),
  };
});
