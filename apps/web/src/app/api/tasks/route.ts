import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db, employees, tasks, teams } from "@wfos/db";
import { taskInputSchema, TASK_STATUSES, type TaskStatus } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";

export const GET = route("VIEWER", async ({ session, req }) => {
  const sp = req.nextUrl.searchParams;
  const conds: SQL[] = [eq(tasks.workspaceId, session.workspaceId)];
  if (sp.get("employeeId")) conds.push(eq(tasks.assigneeId, sp.get("employeeId")!));
  if (sp.get("clientId")) conds.push(eq(tasks.clientId, sp.get("clientId")!));
  if (sp.get("projectId")) conds.push(eq(tasks.projectId, sp.get("projectId")!));
  if (sp.get("parentTaskId")) conds.push(eq(tasks.parentTaskId, sp.get("parentTaskId")!));
  const statuses = sp.get("status")?.split(",").filter((s): s is TaskStatus => (TASK_STATUSES as readonly string[]).includes(s));
  if (statuses?.length) conds.push(inArray(tasks.status, statuses));
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      source: tasks.source,
      assigneeId: tasks.assigneeId,
      teamId: tasks.teamId,
      parentTaskId: tasks.parentTaskId,
      clientId: tasks.clientId,
      projectId: tasks.projectId,
      dryRun: tasks.dryRun,
      phase: tasks.phase,
      costCredits: tasks.costCredits,
      error: tasks.error,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt))
    .limit(Number(sp.get("limit") ?? 300));
  return { tasks: rows };
});

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, taskInputSchema);
  if (!input.assigneeId && !input.teamId) throw new HttpError(400, "Assign the task to an employee or a team", { code: "task_needs_assignee" });
  if (input.assigneeId) {
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, input.assigneeId), eq(employees.workspaceId, session.workspaceId)));
    if (!e) throw new HttpError(400, "Unknown employee", { code: "unknown_employee" });
  }
  if (input.teamId) {
    const [t] = await db.select({ id: teams.id, leadId: teams.leadId }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, session.workspaceId)));
    if (!t) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
    if (!t.leadId) throw new HttpError(400, "This team has no Lead", { code: "team_has_no_lead" });
  }
  const [t] = await db
    .insert(tasks)
    .values({
      workspaceId: session.workspaceId,
      title: input.title,
      brief: input.brief,
      assigneeId: input.assigneeId ?? null,
      teamId: input.teamId ?? null,
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      dryRun: input.dryRun,
      source: "board",
      status: "QUEUED",
      phase: input.start ? null : "hold",
      createdBy: session.userId,
    })
    .returning();
  await publish(session.workspaceId, { type: "task.created", taskId: t!.id, title: t!.title, employeeId: t!.assigneeId });
  if (input.start) await q.task(t!.id, session.workspaceId);
  return { task: t };
});
