import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "./index";
import { createTask, type TaskRow } from "./tasks";
import { employees, skillAuditTasks, tasks, teams } from "./schema";

/**
 * C4: a skill audit is a task for the HR employee: review the team and propose catalog skills (each proposal is an
 * Admin's approval). Started from Settings → Skills or monthly by the worker; one at a time per workspace.
 */

export type SkillAuditTrigger = "manual" | "monthly";

/** The HR employee of a workspace: the head of the division keyed "hr", else the first active employee with an HR role. */
export async function hrEmployeeOf(workspaceId: string): Promise<string | null> {
  const db = getDb();
  const [head] = await db
    .select({ id: teams.leadId })
    .from(teams)
    .innerJoin(employees, eq(employees.id, teams.leadId))
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.key, "hr"), isNotNull(teams.leadId), sql`${employees.status} <> 'ARCHIVED'`));
  if (head?.id) return head.id;
  const [e] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.workspaceId, workspaceId), sql`${employees.status} <> 'ARCHIVED'`, or(sql`${employees.role} ilike '%HR%'`, sql`${employees.role} ilike '%people%'`)))
    .orderBy(asc(employees.createdAt))
    .limit(1);
  return e?.id ?? null;
}

/** The audit still running in this workspace (queued, running or waiting for its approvals), if any. */
export async function activeSkillAudit(workspaceId: string): Promise<{ taskId: string; status: string } | null> {
  const [t] = await getDb()
    .select({ taskId: tasks.id, status: tasks.status })
    .from(skillAuditTasks)
    .innerJoin(tasks, eq(tasks.id, skillAuditTasks.taskId))
    .where(and(eq(skillAuditTasks.workspaceId, workspaceId), inArray(tasks.status, ["QUEUED", "RUNNING", "AWAITING_APPROVAL"])))
    .orderBy(desc(skillAuditTasks.createdAt))
    .limit(1);
  return t ?? null;
}

/**
 * Create the audit task for `hrEmployeeId` (default: hrEmployeeOf) and link it; null when there is no active HR
 * employee. Publishing and enqueueing stay with the caller.
 */
export async function startSkillAudit(input: { workspaceId: string; hrEmployeeId?: string | null; trigger: SkillAuditTrigger; createdBy?: string | null }): Promise<TaskRow | null> {
  const db = getDb();
  const hrId = input.hrEmployeeId ?? (await hrEmployeeOf(input.workspaceId));
  const [hr] = hrId
    ? await db
        .select({ id: employees.id, status: employees.status })
        .from(employees)
        .where(and(eq(employees.id, hrId), eq(employees.workspaceId, input.workspaceId)))
    : [];
  if (!hr || hr.status === "ARCHIVED") return null;
  return db.transaction(async (tx) => {
    const task = await createTask(tx, {
      workspaceId: input.workspaceId,
      title: input.trigger === "monthly" ? "Monthly skill audit of the team" : "Skill audit of the team",
      brief:
        "Review every employee's role and recent work, find skills in the open catalog (skills.sh) that would make their work better, " +
        "and propose them with propose_skill (an Admin approves each). End with a short table of what you proposed and why.",
      assigneeId: hr.id,
      source: input.trigger === "monthly" ? "routine" : "board",
      createdBy: input.createdBy ?? null,
    });
    await tx.insert(skillAuditTasks).values({ taskId: task.id, workspaceId: input.workspaceId, trigger: input.trigger });
    return task;
  });
}
