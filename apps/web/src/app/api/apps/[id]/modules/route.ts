import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import { appDocumentTasks, appModules, appModuleTasks, appModuleViews, audit, db, MODULE_SLUG, moduleSlug } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { activeEmployee, prdTaskInput, startTask, taskInput400, unique409 } from "@/lib/server/app-modules";
import { body, route } from "@/lib/server/route";
import { createTaskOr400 } from "@/lib/server/tasks";

/** C8: the app's modules with their derived status (from tasks, merges and releases). */
export const GET = route<{ id: string }>("MEMBER", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  return { modules: await appModuleViews(session.workspaceId, app.id), hasRepository: !!app.repositoryId };
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(MODULE_SLUG).optional(),
  summary: z.string().trim().max(4000).default(""),
  /** an employee who writes the module's first PRD now (optional: it can be asked for later) */
  writerId: z.string().uuid().optional(),
});

const SLUG_TAKEN = "A module with this technical name exists in the app";

/**
 * Add a module: a name and what it is for. With a writer, a task writes its first PRD (a draft an Admin approves,
 * like the app's documents); nothing is built until a person asks for it.
 */
export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const b = await body(req, createSchema);
  const app = await loadApp(session.workspaceId, params.id);
  const slug = b.slug ?? moduleSlug(b.name);
  const [taken] = await db.select({ id: appModules.id }).from(appModules).where(and(eq(appModules.appId, app.id), eq(appModules.slug, slug)));
  if (taken) throw new HttpError(409, SLUG_TAKEN, { code: "app_module_slug_taken" });
  const writer = b.writerId ? await activeEmployee(session.workspaceId, b.writerId) : null;
  // two people adding the same name at once: the unique index decides, the loser gets the same 409
  const { module, taskId } = await unique409("app_modules_slug", "app_module_slug_taken", SLUG_TAKEN, () =>
    taskInput400(() =>
      db.transaction(async (tx) => {
        const [pos] = await tx.select({ p: max(appModules.position) }).from(appModules).where(eq(appModules.appId, app.id));
        const [module] = await tx
          .insert(appModules)
          .values({ workspaceId: session.workspaceId, appId: app.id, slug, name: b.name, summary: b.summary, position: (pos?.p ?? -1) + 1, createdBy: session.userId })
          .returning();
        if (!writer) return { module: module!, taskId: null };
        const task = await createTaskOr400(tx, prdTaskInput(session, app, module!, writer.id, ""));
        await tx.insert(appDocumentTasks).values({ taskId: task.id, workspaceId: session.workspaceId, appId: app.id, moduleId: module!.id, kind: "prd" });
        await tx.insert(appModuleTasks).values({ taskId: task.id, moduleId: module!.id, workspaceId: session.workspaceId, role: "prd", createdBy: session.userId });
        return { module: module!, taskId: task.id };
      }),
    ),
  );
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.module_created", targetType: "app", targetId: app.id, details: { name: app.name, module: module.name, slug, writer: writer?.name ?? null } });
  if (taskId) await startTask(session.workspaceId, taskId, writer!.id, `PRD modul: ${module.name}`);
  return { id: module.id, slug, taskId };
});
