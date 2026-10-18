import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { appReleases, appTests, audit, db, employees, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp, loadEnv } from "@/lib/server/apps";
import { effectiveTestStatus } from "@/lib/server/app-tests";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";
import { createTaskOr400 } from "@/lib/server/tasks";

/** C3: the app's browser tests (preview), newest first, with their findings. */
export const GET = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const limit = Math.min(20, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 10));
  const rows = await db
    .select({ t: appTests, taskStatus: tasks.status, tester: employees.name })
    .from(appTests)
    .leftJoin(tasks, eq(tasks.id, appTests.taskId))
    .leftJoin(employees, eq(employees.id, tasks.assigneeId))
    .where(and(eq(appTests.appId, app.id), eq(appTests.workspaceId, session.workspaceId)))
    .orderBy(desc(appTests.createdAt))
    .limit(limit);
  return {
    tests: rows.map((r) => ({
      id: r.t.id,
      status: effectiveTestStatus(r.t.status, r.taskStatus),
      commit: r.t.commit,
      focus: r.t.focus,
      roles: r.t.roles,
      summary: r.t.summary,
      findings: r.t.findings,
      handledAt: r.t.handledAt,
      createdAt: r.t.createdAt,
      finishedAt: r.t.finishedAt,
      task: r.t.taskId ? { id: r.t.taskId, status: r.taskStatus, tester: r.tester } : null,
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
  if (busy) throw new HttpError(409, "A test of this preview is already running", { code: "app_test_running" });
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
