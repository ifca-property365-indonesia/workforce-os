import "server-only";
import { and, eq } from "drizzle-orm";
import { appModules, audit, db, employees, takeQueuedModuleWork, TaskInputError, teams } from "@wfos/db";
import { HttpError } from "./auth";
import { isUuid } from "./apps";
import { publish, q } from "./queue";
import { notFound } from "./route";

export type ModuleRow = typeof appModules.$inferSelect;

/** A module of this app in this workspace, else 404. */
export async function loadModule(workspaceId: string, appId: string, moduleId: string): Promise<ModuleRow> {
  if (!isUuid(moduleId)) notFound("app_module_not_found");
  const [m] = await db.select().from(appModules).where(and(eq(appModules.id, moduleId), eq(appModules.appId, appId), eq(appModules.workspaceId, workspaceId)));
  if (!m) notFound("app_module_not_found");
  return m;
}

/** a lost race on a unique index (two people adding the same module, or claiming the same task) as its 409 */
export async function unique409<T>(constraint: string, code: string, message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const pg = ((e as { cause?: unknown })?.cause ?? e) as { code?: string; constraint_name?: string };
    // i18n-ignore: callers pass codes that have an errors.<code> message (app_module_slug_taken, app_module_task_linked)
    if (pg?.code === "23505" && pg.constraint_name === constraint) throw new HttpError(409, message, { code });
    throw e;
  }
}

/** createTask() inside the module helpers: a refused reference becomes a 400 with its translated errors.<code>. */
export async function taskInput400<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // i18n-ignore: every TASK_INPUT_ERROR_CODES entry has an errors.<code> message (checked in test/tasks.test.ts)
    if (e instanceof TaskInputError) throw new HttpError(400, e.message, { code: e.code });
    throw e;
  }
}

/**
 * Who can write code on an app's repository: an active employee in Workspace mode (a sandbox with the checkout), or a
 * division with a code lead (who builds in one). Anyone else would finish the task without touching the code.
 */
export async function assertBuilder(workspaceId: string, b: { employeeId?: string; teamId?: string }): Promise<void> {
  if (b.employeeId) {
    const [e] = await db.select({ status: employees.status, mode: employees.executionMode }).from(employees).where(and(eq(employees.id, b.employeeId), eq(employees.workspaceId, workspaceId)));
    if (!e || e.status === "ARCHIVED") throw new HttpError(400, "Choose an employee of this workspace", { code: "writer_not_found" });
    if (e.mode !== "workspace") throw new HttpError(400, "Only an employee in Workspace mode (or a division with a code lead) can change the app's code", { code: "builder_not_coder" });
  }
  if (b.teamId) {
    const [t] = await db.select({ codeLeadId: teams.codeLeadId }).from(teams).where(and(eq(teams.id, b.teamId), eq(teams.workspaceId, workspaceId)));
    if (!t) throw new HttpError(400, "Choose a division of this workspace", { code: "unknown_team" });
    if (!t.codeLeadId) throw new HttpError(400, "Only an employee in Workspace mode (or a division with a code lead) can change the app's code", { code: "builder_not_coder" });
  }
}

/** an active employee of this workspace (who writes or builds), else 400 */
export async function activeEmployee(workspaceId: string, id: string) {
  const [emp] = await db.select({ id: employees.id, name: employees.name, status: employees.status }).from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId)));
  if (!emp || emp.status === "ARCHIVED") throw new HttpError(400, "Choose an employee of this workspace", { code: "writer_not_found" });
  return emp;
}

/** the task that writes (a new version of) a module's PRD; its run may save exactly that PRD (save_app_document) */
export function prdTaskInput(
  session: { workspaceId: string; userId: string },
  app: { name: string; clientId: string | null; projectId: string | null },
  module: { name: string; slug: string },
  writerId: string,
  note: string,
) {
  return {
    workspaceId: session.workspaceId,
    title: `PRD modul: ${module.name} (${app.name})`.slice(0, 200),
    brief: [`Write the PRD of the module "${module.name}" (${module.slug}) of ${app.name} and save it with save_app_document.`, note].filter(Boolean).join("\n\n"),
    assigneeId: writerId,
    clientId: app.clientId,
    projectId: app.projectId,
    source: "board" as const,
    createdBy: session.userId,
  };
}

export async function startTask(workspaceId: string, taskId: string, employeeId: string | null, title: string) {
  await publish(workspaceId, { type: "task.created", taskId, title, employeeId });
  await q.task(taskId, workspaceId);
}

/** Start the oldest build or change that waits for this app, if none runs now (see takeQueuedModuleWork). */
export async function startWaitingModuleWork(workspaceId: string, appId: string): Promise<void> {
  const { task, dropped } = await takeQueuedModuleWork(db, workspaceId, appId);
  if (dropped) {
    await audit({ workspaceId, actorLabel: "system", action: "app.module_work_dropped", targetType: "app", targetId: appId, details: { moduleId: dropped.moduleId, error: dropped.error.slice(0, 300) } });
  }
  if (task) await startTask(workspaceId, task.id, task.assigneeId, task.title);
}
