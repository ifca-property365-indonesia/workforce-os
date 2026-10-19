import { z } from "zod";
import { activeModuleWork, appDesign, audit, db, lockAppModules } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { assertBuilder, startTask, taskInput400 } from "@/lib/server/app-modules";
import { body, route } from "@/lib/server/route";
import { createTaskOr400 } from "@/lib/server/tasks";

const schema = z
  .object({ employeeId: z.string().uuid().optional(), teamId: z.string().uuid().optional(), note: z.string().trim().max(4000).default("") })
  .refine((b) => !!b.employeeId !== !!b.teamId, { message: "Choose an employee or a division" });

/**
 * "Terapkan tampilan" (Admins): a code task that restyles the existing app to its UI template / Figma file: only how it
 * looks, never what it does. Published the usual way (push and preview approvals). Not while a module is being built
 * (both would change the same screens).
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  if (!app.repositoryId) throw new HttpError(409, "Link a repository to the app first", { code: "app_no_repository" });
  const design = await appDesign(session.workspaceId, app.id);
  if (!design.template && !design.figma) throw new HttpError(409, "Choose a UI template or a Figma file first", { code: "app_no_design" });
  await assertBuilder(session.workspaceId, b);
  const look = [design.template ? `the UI template "${design.template.name}"` : "", design.figma ? "the Figma file" : ""].filter(Boolean).join(" and ");
  const task = await taskInput400(() =>
    db.transaction(async (tx) => {
      await lockAppModules(tx, app.id);
      const running = await activeModuleWork(tx, app.id);
      if (running) throw new HttpError(409, "A module of this app is being built: restyle when it is done", { code: "app_module_busy", task: running.title });
      return createTaskOr400(tx, {
        workspaceId: session.workspaceId,
        title: `Terapkan tampilan: ${app.name}`.slice(0, 200),
        brief: [
          `Restyle ${app.name} to ${look}: change only how it looks (tokens, fonts, components, layout), never what it does (data, routes, API, validation, permissions, texts). Follow the ui-kits skill. Work screen by screen and list any screen you could not convert.`,
          b.note ? `Request: ${b.note}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        assigneeId: b.employeeId ?? null,
        teamId: b.teamId ?? null,
        clientId: app.clientId,
        projectId: app.projectId,
        repositoryId: app.repositoryId,
        source: "board",
        createdBy: session.userId,
      });
    }),
  );
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.restyle_requested", targetType: "app", targetId: app.id, details: { name: app.name, template: design.template?.ref ?? null, figma: !!design.figma, taskId: task.id } });
  await startTask(session.workspaceId, task.id, task.assigneeId, task.title);
  return { taskId: task.id };
});
