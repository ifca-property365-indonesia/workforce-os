import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentWorkOnRepository, appModuleTasks, audit, db } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { loadModule, unique409 } from "@/lib/server/app-modules";
import { body, route } from "@/lib/server/route";

/**
 * "Daftarkan modul": earlier work on the app's repository that no module claims yet: tasks whose push the platform
 * recorded (with what was decided about merging it). Picked by a person from facts, never guessed from a summary.
 */
export const GET = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  await loadModule(session.workspaceId, app.id, params.moduleId);
  if (!app.repositoryId) return { candidates: [] };
  const work = await agentWorkOnRepository(session.workspaceId, app.repositoryId);
  const claimed = work.length
    ? new Set((await db.select({ id: appModuleTasks.taskId }).from(appModuleTasks).where(inArray(appModuleTasks.taskId, work.map((w) => w.taskId)))).map((r) => r.id))
    : new Set<string>();
  return {
    candidates: work
      .filter((w) => !claimed.has(w.taskId) && w.state !== "skipped")
      .slice(0, 30)
      .map((w) => ({ taskId: w.taskId, title: w.title, branch: w.branch, head: w.head, pushedAt: w.pushedAt, state: w.state })),
  };
});

const schema = z.object({ taskId: z.string().uuid() });
const LINKED = "That task already belongs to a module";

/** Link that work to this module (role register): no rework, its pushes and merges now count for the module. Admins. */
export const POST = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  if (!app.repositoryId) throw new HttpError(409, "Link a repository to the app first", { code: "app_no_repository" });
  const [w] = await agentWorkOnRepository(session.workspaceId, app.repositoryId, { taskIds: [b.taskId] });
  if (!w) throw new HttpError(400, "That task pushed no work to this app's repository", { code: "app_module_no_work" });
  const [taken] = await db.select({ moduleId: appModuleTasks.moduleId }).from(appModuleTasks).where(eq(appModuleTasks.taskId, b.taskId));
  if (taken) throw new HttpError(409, LINKED, { code: "app_module_task_linked" });
  await unique409("app_module_tasks_pkey", "app_module_task_linked", LINKED, () =>
    db.insert(appModuleTasks).values({ taskId: b.taskId, moduleId: m.id, workspaceId: session.workspaceId, role: "register", createdBy: session.userId }),
  );
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.module_work_registered",
    targetType: "app",
    targetId: app.id,
    details: { name: app.name, module: m.name, taskId: b.taskId, head: w.head, state: w.state },
  });
  return { ok: true, state: w.state };
});
