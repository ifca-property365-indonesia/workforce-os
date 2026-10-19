import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { appDocuments, appModules, audit, db, requestModuleWork } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { assertBuilder, loadModule, startTask, taskInput400 } from "@/lib/server/app-modules";
import { body, route } from "@/lib/server/route";

const schema = z
  .object({
    role: z.enum(["build", "change"]),
    employeeId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    note: z.string().trim().max(4000).default(""),
  })
  .refine((b) => !!b.employeeId !== !!b.teamId, { message: "Choose an employee or a division" })
  .refine((b) => b.role === "build" || b.note.length >= 5, { message: "Say what should change", path: ["note"] });

/**
 * Build the module from its approved PRD, or change it (Admins): a code task on the app's repository, linked to the
 * module. One build or change runs per app: while another runs, the request waits on the module and starts when that
 * one ends. Publishing goes the usual way (push and preview approvals, merge, LIVE by the Owner).
 */
export const POST = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  if (!app.repositoryId) throw new HttpError(409, "Link a repository to the app first", { code: "app_no_repository" });
  if (m.hold) throw new HttpError(409, "This module is paused or dropped", { code: "app_module_on_hold" });
  if (b.role === "build") {
    const [prd] = await db
      .select({ id: appDocuments.id })
      .from(appDocuments)
      .where(and(eq(appDocuments.moduleId, m.id), eq(appDocuments.kind, "prd"), eq(appDocuments.status, "approved")))
      .limit(1);
    if (!prd) throw new HttpError(409, "Approve the module's PRD first", { code: "app_module_no_prd" });
  }
  await assertBuilder(session.workspaceId, b);
  const r = await taskInput400(() =>
    db.transaction((tx) =>
      requestModuleWork(tx, {
        workspaceId: session.workspaceId,
        app: { id: app.id, name: app.name, repositoryId: app.repositoryId, clientId: app.clientId, projectId: app.projectId },
        module: { id: m.id, name: m.name, slug: m.slug },
        role: b.role,
        employeeId: b.employeeId ?? null,
        teamId: b.teamId ?? null,
        note: b.note,
        createdBy: session.userId,
      }),
    ),
  );
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: r.task ? "app.module_work_started" : "app.module_work_queued",
    targetType: "app",
    targetId: app.id,
    details: { name: app.name, module: m.name, role: b.role, taskId: r.task?.id ?? null, waitingFor: r.waitingFor },
  });
  if (r.task) await startTask(session.workspaceId, r.task.id, r.task.assigneeId, r.task.title);
  return { taskId: r.task?.id ?? null, waitingFor: r.waitingFor };
});

/** Cancel a build or change that waits for the app (Admins). A running one is cancelled on its task. */
export const DELETE = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  const [row] = await db.update(appModules).set({ pendingWork: null, updatedAt: new Date() }).where(and(eq(appModules.id, m.id), isNull(appModules.hold))).returning({ id: appModules.id });
  if (row && m.pendingWork) {
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.module_work_unqueued", targetType: "app", targetId: app.id, details: { name: app.name, module: m.name } });
  }
  return { ok: true };
});
