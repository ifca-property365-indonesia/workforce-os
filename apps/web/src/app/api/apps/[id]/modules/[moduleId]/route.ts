import { and, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { appDocuments, appModules, appModuleTasks, appModuleViews, audit, db, employees, MODULE_SLUG } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { loadModule } from "@/lib/server/app-modules";
import { patchBody, route } from "@/lib/server/route";

/** C8: one module: its derived status, its tasks and work, and every version of its PRD (no content). */
export const GET = route<{ id: string; moduleId: string }>("MEMBER", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  const [view] = await appModuleViews(session.workspaceId, app.id, { moduleId: m.id });
  const prd = await db
    .select({
      id: appDocuments.id,
      version: appDocuments.version,
      title: appDocuments.title,
      status: appDocuments.status,
      note: appDocuments.note,
      basedOnVersion: appDocuments.basedOnVersion,
      taskId: appDocuments.taskId,
      author: employees.name,
      createdAt: appDocuments.createdAt,
      decidedAt: appDocuments.decidedAt,
    })
    .from(appDocuments)
    .leftJoin(employees, eq(employees.id, appDocuments.authorEmployeeId))
    .where(and(eq(appDocuments.moduleId, m.id), eq(appDocuments.kind, "prd")))
    .orderBy(desc(appDocuments.version));
  return { module: view, prd, hasRepository: !!app.repositoryId };
});

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    summary: z.string().trim().max(4000),
    slug: z.string().trim().regex(MODULE_SLUG),
    position: z.number().int().min(0).max(10_000),
    hold: z.enum(["paused", "dropped"]).nullable(),
  })
  .partial();

/**
 * Edit a module (Admins): name, purpose, order, and a hold (paused / dropped stop new builds; a waiting build is
 * dropped with it). The technical name changes only while nothing was built for it (code and branches follow it).
 */
export const PATCH = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await patchBody(req, patchSchema);
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  if (b.slug !== undefined && b.slug !== m.slug) {
    const [work] = await db.select({ n: count() }).from(appModuleTasks).where(and(eq(appModuleTasks.moduleId, m.id), ne(appModuleTasks.role, "prd")));
    if (Number(work?.n ?? 0) > 0) throw new HttpError(409, "The technical name is fixed once the module was built", { code: "app_module_slug_fixed" });
    const [taken] = await db.select({ id: appModules.id }).from(appModules).where(and(eq(appModules.appId, app.id), eq(appModules.slug, b.slug), ne(appModules.id, m.id)));
    if (taken) throw new HttpError(409, "A module with this technical name exists in the app", { code: "app_module_slug_taken" });
  }
  await db
    .update(appModules)
    .set({ ...b, ...(b.hold ? { pendingWork: null } : {}), updatedAt: new Date() })
    .where(eq(appModules.id, m.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.module_updated", targetType: "app", targetId: app.id, details: { name: app.name, module: m.name, changes: b } });
  return { ok: true };
});

/** Remove a module that nothing was built for (Admins). A module with work is dropped instead (PATCH hold). */
export const DELETE = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  const [work] = await db.select({ n: count() }).from(appModuleTasks).where(and(eq(appModuleTasks.moduleId, m.id), ne(appModuleTasks.role, "prd")));
  if (Number(work?.n ?? 0) > 0) throw new HttpError(409, "This module has work: drop it instead of removing it", { code: "app_module_has_work" });
  await db.delete(appModules).where(eq(appModules.id, m.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.module_removed", targetType: "app", targetId: app.id, details: { name: app.name, module: m.name } });
  return { ok: true };
});
