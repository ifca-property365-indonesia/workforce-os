import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { appReleases, appTests, appTestSuites, audit, db, employees, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp, loadEnv } from "@/lib/server/apps";
import { effectiveTestStatus } from "@/lib/server/app-tests";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";
import { createTaskOr400 } from "@/lib/server/tasks";

/** a test row with its task's status and tester, as the panel shows it */
const testRows = (where: ReturnType<typeof and>) =>
  db
    .select({ t: appTests, taskStatus: tasks.status, tester: employees.name })
    .from(appTests)
    .leftJoin(tasks, eq(tasks.id, appTests.taskId))
    .leftJoin(employees, eq(employees.id, tasks.assigneeId))
    .where(where);
const testDTO = (r: Awaited<ReturnType<typeof testRows>>[number]) => ({
  id: r.t.id,
  status: effectiveTestStatus(r.t.status, r.taskStatus),
  commit: r.t.commit,
  focus: r.t.focus,
  roles: r.t.roles,
  title: r.t.title,
  position: r.t.position,
  summary: r.t.summary,
  findings: r.t.findings,
  handledAt: r.t.handledAt,
  createdAt: r.t.createdAt,
  finishedAt: r.t.finishedAt,
  task: r.t.taskId ? { id: r.t.taskId, status: r.taskStatus, tester: r.tester } : null,
});

/** C3: the app's browser tests (preview), newest first, with their findings; and its latest full tests with their packages. */
export const GET = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const limit = Math.min(20, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 10));
  const single = await testRows(and(eq(appTests.appId, app.id), eq(appTests.workspaceId, session.workspaceId), isNull(appTests.suiteId)))
    .orderBy(desc(appTests.createdAt))
    .limit(limit);
  const suites = await db
    .select({ s: appTestSuites, tester: employees.name })
    .from(appTestSuites)
    .leftJoin(employees, eq(employees.id, appTestSuites.employeeId))
    .where(and(eq(appTestSuites.appId, app.id), eq(appTestSuites.workspaceId, session.workspaceId)))
    .orderBy(desc(appTestSuites.createdAt))
    .limit(3);
  const packages = suites.length
    ? await testRows(inArray(appTests.suiteId, suites.map((x) => x.s.id))).orderBy(asc(appTests.position))
    : [];
  return {
    tests: single.map(testDTO),
    suites: suites.map((x) => ({
      id: x.s.id,
      status: x.s.status,
      focus: x.s.focus,
      tester: x.tester,
      createdAt: x.s.createdAt,
      finishedAt: x.s.finishedAt,
      packages: packages.filter((p) => p.t.suiteId === x.s.id).map(testDTO),
    })),
  };
});

const startSchema = z.object({
  employeeId: z.string().uuid(),
  focus: z.string().trim().max(2000).default(""),
  roles: z.array(z.string().min(1).max(40)).max(20).default([]),
});

/**
 * Start a browser test of the running preview: a task for the chosen tester (an employee of this workspace) that
 * drives the preview's browser through the app-test tools and ends with a report. Started by a person (never on
 * every release), so its cost is a decision.
 */
export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const b = await body(req, startSchema);
  const app = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, app.id, "preview");
  if (env.status !== "running" || !env.currentReleaseId) throw new HttpError(409, "The preview is not running: publish it first", { code: "preview_not_running" });
  const [emp] = await db.select().from(employees).where(and(eq(employees.id, b.employeeId), eq(employees.workspaceId, session.workspaceId)));
  if (!emp || emp.status === "ARCHIVED") throw new HttpError(400, "Choose an employee of this workspace as the tester", { code: "tester_not_found" });
  const [busy] = await db
    .select({ id: appTests.id })
    .from(appTests)
    .innerJoin(tasks, eq(tasks.id, appTests.taskId))
    .where(and(eq(appTests.environmentId, env.id), eq(appTests.status, "running"), inArray(tasks.status, ["QUEUED", "RUNNING", "AWAITING_APPROVAL"])));
  const [suite] = await db.select({ id: appTestSuites.id }).from(appTestSuites).where(and(eq(appTestSuites.environmentId, env.id), eq(appTestSuites.status, "running")));
  if (busy || suite) throw new HttpError(409, "A test of this preview is already running", { code: "app_test_running" });
  const [rel] = await db.select({ commit: appReleases.commit }).from(appReleases).where(eq(appReleases.id, env.currentReleaseId));
  const task = await createTaskOr400(db, {
    workspaceId: session.workspaceId,
    title: `Uji aplikasi: ${app.name}`.slice(0, 200),
    brief: [
      `Test the preview of ${app.name} (https://${env.domain}) in the browser and report with report_app_test.`,
      b.focus ? `Focus: ${b.focus}` : "",
      b.roles.length ? `Roles to cover: ${b.roles.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    assigneeId: emp.id,
    clientId: app.clientId,
    projectId: app.projectId,
    source: "board",
    createdBy: session.userId,
  });
  const [test] = await db
    .insert(appTests)
    .values({ workspaceId: session.workspaceId, appId: app.id, environmentId: env.id, taskId: task.id, commit: rel?.commit ?? null, focus: b.focus, roles: b.roles, createdBy: session.userId })
    .returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.test_started", targetType: "app", targetId: app.id, details: { name: app.name, testId: test!.id, taskId: task.id, tester: emp.name } });
  await publish(session.workspaceId, { type: "task.created", taskId: task.id, title: task.title, employeeId: emp.id });
  await q.task(task.id, session.workspaceId);
  return { testId: test!.id, taskId: task.id };
});
