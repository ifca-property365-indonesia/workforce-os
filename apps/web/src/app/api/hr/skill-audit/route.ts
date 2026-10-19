import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activeSkillAudit, approvals, audit, db, employees, hrEmployeeOf, skillAuditTasks, startSkillAudit, tasks, workspaces } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, patchBody, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";

/**
 * C4: the HR employee's skill audit of the team. Settings (workspaces.settings.skillAudit): the monthly run (the 1st,
 * 09:00) and who runs it (default: the head of the HR division). Each skill it proposes is an Admin's approval.
 */

const settingsSchema = z.object({ monthly: z.boolean(), hrEmployeeId: z.string().uuid().nullable() });
type AuditSettings = z.infer<typeof settingsSchema>;

async function current(workspaceId: string): Promise<AuditSettings> {
  const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const r = settingsSchema.safeParse((ws?.settings as { skillAudit?: unknown } | undefined)?.skillAudit);
  return r.success ? r.data : { monthly: false, hrEmployeeId: null };
}

async function activeEmployee(workspaceId: string, id: string) {
  const [e] = await db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId), sql`${employees.status} <> 'ARCHIVED'`));
  return e ?? null;
}

export const GET = route("ADMIN", async ({ session }) => {
  const ws = session.workspaceId;
  const settings = await current(ws);
  const hrId = settings.hrEmployeeId ?? (await hrEmployeeOf(ws));
  const [last] = await db
    .select({ taskId: tasks.id, title: tasks.title, status: tasks.status, trigger: skillAuditTasks.trigger, createdAt: skillAuditTasks.createdAt })
    .from(skillAuditTasks)
    .innerJoin(tasks, eq(tasks.id, skillAuditTasks.taskId))
    .where(eq(skillAuditTasks.workspaceId, ws))
    .orderBy(desc(skillAuditTasks.createdAt))
    .limit(1);
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, ws), eq(approvals.toolName, "install_skill"), eq(approvals.status, "PENDING")));
  return { settings, hrEmployee: hrId ? await activeEmployee(ws, hrId) : null, last: last ?? null, pendingProposals: pending?.n ?? 0 };
});

export const PUT = route("ADMIN", async ({ session, req }) => {
  const input = await patchBody(req, settingsSchema.partial());
  const before = await current(session.workspaceId);
  const next = settingsSchema.parse({ ...before, ...input });
  if (next.hrEmployeeId && !(await activeEmployee(session.workspaceId, next.hrEmployeeId))) {
    throw new HttpError(400, "Choose an active employee of this workspace", { code: "skill_audit_no_hr" });
  }
  // merged in SQL: the other settings keys are never overwritten, even by a concurrent save
  await db
    .update(workspaces)
    .set({ settings: sql`coalesce(${workspaces.settings}, '{}'::jsonb) || jsonb_build_object('skillAudit', ${JSON.stringify(next)}::jsonb)` })
    .where(eq(workspaces.id, session.workspaceId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "settings.skill_audit_changed", targetType: "workspace", targetId: session.workspaceId, details: { before, after: next } });
  return { settings: next };
});

/** Start an audit now (one at a time). */
export const POST = route("ADMIN", async ({ session, req }) => {
  const b = await body(req, z.object({ hrEmployeeId: z.string().uuid().optional() }));
  const ws = session.workspaceId;
  const running = await activeSkillAudit(ws);
  if (running) throw new HttpError(409, "A skill audit is still running", { code: "skill_audit_running", taskId: running.taskId });
  const settings = await current(ws);
  const task = await startSkillAudit({ workspaceId: ws, hrEmployeeId: b.hrEmployeeId ?? settings.hrEmployeeId, trigger: "manual", createdBy: session.userId });
  if (!task) throw new HttpError(400, "No active HR employee to run the audit", { code: "skill_audit_no_hr" });
  await audit({ workspaceId: ws, actorUserId: session.userId, actorLabel: session.email, action: "skills.audit_started", targetType: "task", targetId: task.id, details: { assigneeId: task.assigneeId } });
  await publish(ws, { type: "task.created", taskId: task.id, title: task.title, employeeId: task.assigneeId });
  await q.task(task.id, ws);
  return { taskId: task.id };
});
