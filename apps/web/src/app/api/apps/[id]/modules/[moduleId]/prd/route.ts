import { z } from "zod";
import { appDocumentTasks, appModuleTasks, audit, db } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { activeEmployee, loadModule, prdTaskInput, startTask } from "@/lib/server/app-modules";
import { body, route } from "@/lib/server/route";
import { createTaskOr400 } from "@/lib/server/tasks";

const schema = z.object({ employeeId: z.string().uuid(), note: z.string().trim().max(2000).default("") });

/**
 * Ask an employee to write (a new version of) the module's PRD: a task whose run may save exactly that PRD. The
 * draft is compared with the approved version and approved by an Admin, never applied by itself.
 */
export const POST = route<{ id: string; moduleId: string }>("MEMBER", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  if (m.hold === "dropped") throw new HttpError(409, "This module was dropped", { code: "app_module_on_hold" });
  const writer = await activeEmployee(session.workspaceId, b.employeeId);
  const task = await db.transaction(async (tx) => {
    const t = await createTaskOr400(tx, prdTaskInput(session, app, m, writer.id, b.note));
    await tx.insert(appDocumentTasks).values({ taskId: t.id, workspaceId: session.workspaceId, appId: app.id, moduleId: m.id, kind: "prd" });
    await tx.insert(appModuleTasks).values({ taskId: t.id, moduleId: m.id, workspaceId: session.workspaceId, role: "prd", createdBy: session.userId });
    return t;
  });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.module_prd_requested", targetType: "app", targetId: app.id, details: { name: app.name, module: m.name, taskId: task.id, writer: writer.name } });
  await startTask(session.workspaceId, task.id, writer.id, task.title);
  return { taskId: task.id };
});
