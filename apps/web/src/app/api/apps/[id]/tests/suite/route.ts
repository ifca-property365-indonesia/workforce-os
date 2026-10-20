import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { appReleases, appTests, appTestSuites, audit, db, employees, startAppTestSuite, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp, loadEnv } from "@/lib/server/apps";
import { unique409 } from "@/lib/server/app-modules";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";

const schema = z.object({
  employeeId: z.string().uuid(),
  focus: z.string().trim().max(2000).default(""),
  roles: z.array(z.string().min(1).max(40)).max(20).default([]),
});

/**
 * A full test of the running preview (after AIRIS eda913b): the app's active modules split into packages, tested one
 * after the other by the chosen tester, each in its own session. Up to SUITE_MAX_PACKAGES sessions, so an Admin's
 * decision; one summary when the last package ends.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, app.id, "preview");
  if (env.status !== "running" || !env.currentReleaseId) throw new HttpError(409, "The preview is not running: publish it first", { code: "preview_not_running" });
  const [emp] = await db.select().from(employees).where(and(eq(employees.id, b.employeeId), eq(employees.workspaceId, session.workspaceId)));
  if (!emp || emp.status === "ARCHIVED") throw new HttpError(400, "Choose an employee of this workspace as the tester", { code: "tester_not_found" });
  const [suiteRunning] = await db.select({ id: appTestSuites.id }).from(appTestSuites).where(and(eq(appTestSuites.environmentId, env.id), eq(appTestSuites.status, "running")));
  const [testRunning] = await db
    .select({ id: appTests.id })
    .from(appTests)
    .innerJoin(tasks, eq(tasks.id, appTests.taskId))
    .where(and(eq(appTests.environmentId, env.id), eq(appTests.status, "running"), inArray(tasks.status, ["QUEUED", "RUNNING", "AWAITING_APPROVAL"])));
  if (suiteRunning || testRunning) throw new HttpError(409, "A test of this preview is already running", { code: "app_test_running" });
  const [rel] = await db.select({ commit: appReleases.commit }).from(appReleases).where(eq(appReleases.id, env.currentReleaseId));
  const started = await unique409("app_test_suites_running", "app_test_running", "A test of this preview is already running", () =>
    db.transaction((tx) =>
      startAppTestSuite(tx, {
        workspaceId: session.workspaceId,
        app: { id: app.id, name: app.name, clientId: app.clientId, projectId: app.projectId },
        environmentId: env.id,
        commit: rel?.commit ?? null,
        employeeId: emp.id,
        focus: b.focus,
        roles: b.roles,
        createdBy: session.userId,
      }),
    ),
  ).catch((e: unknown) => {
    if (e instanceof Error && e.message === "the app has no active module") throw new HttpError(409, "Add the app's modules first: a full test tests them one by one", { code: "app_has_no_modules" });
    throw e;
  });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.test_suite_started",
    targetType: "app",
    targetId: app.id,
    details: { name: app.name, suiteId: started.suiteId, packages: started.packages, tester: emp.name },
  });
  await publish(session.workspaceId, { type: "task.created", taskId: started.task.id, title: started.task.title, employeeId: emp.id });
  await q.task(started.task.id, session.workspaceId);
  return { suiteId: started.suiteId, packages: started.packages, taskId: started.task.id };
});
