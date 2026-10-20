import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type DB } from "./index";
import { createTask, type TaskRow } from "./tasks";
import { appModules, appTests, appTestSuites, type AppTestStatus } from "./schema";

/**
 * A full test of an app (after AIRIS eda913b). The app's active modules are split into packages (one module each, or
 * a few when there are many), tested one after the other by the same tester, each in its own session with its own
 * report. The end of a package's task starts the next one (advanceAppTestSuite); the last one ends the suite.
 */

/** at most this many packages (sessions) per full test: more modules are grouped */
export const SUITE_MAX_PACKAGES = 12;

export interface SuitePackage {
  title: string;
  moduleIds: string[];
}

/** Modules in their order, grouped so there are at most SUITE_MAX_PACKAGES packages (neighbours share one). */
export function planSuitePackages(modules: { id: string; name: string }[]): SuitePackage[] {
  const per = Math.max(1, Math.ceil(modules.length / SUITE_MAX_PACKAGES));
  const out: SuitePackage[] = [];
  for (let i = 0; i < modules.length; i += per) {
    const group = modules.slice(i, i + per);
    out.push({ title: group.map((m) => m.name).join(", ").slice(0, 200), moduleIds: group.map((m) => m.id) });
  }
  return out;
}

type Database = Pick<DB, "select" | "insert" | "update" | "execute">;
type SuiteApp = { id: string; name: string; clientId: string | null; projectId: string | null };

export interface SuiteInput {
  workspaceId: string;
  app: SuiteApp;
  environmentId: string;
  commit: string | null;
  employeeId: string;
  focus: string;
  roles: string[];
  createdBy: string | null;
}

/** serializes a suite's hand-over (the end of one package, a stop) */
async function lockSuite(database: Pick<DB, "execute">, suiteId: string): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`wfos-test-suite:${suiteId}`}))`);
}

/** The task of one package: the tester's session for those modules (the prompt adds their PRDs as data). */
async function startPackage(database: Database, suite: typeof appTestSuites.$inferSelect, test: typeof appTests.$inferSelect, count: number, app: SuiteApp): Promise<TaskRow> {
  const task = await createTask(database, {
    workspaceId: suite.workspaceId,
    title: `Uji menyeluruh ${test.position + 1}/${count}: ${test.title} (${app.name})`.slice(0, 200),
    brief: `Full test of ${app.name}, package ${test.position + 1} of ${count}: test only the module(s) ${test.title}. Other modules are tested in separate sessions. Report with report_app_test.`,
    assigneeId: suite.employeeId,
    clientId: app.clientId,
    projectId: app.projectId,
    source: "board",
    createdBy: suite.createdBy,
  });
  await database.update(appTests).set({ taskId: task.id, status: "running" }).where(eq(appTests.id, test.id));
  return task;
}

/**
 * Start a full test: the suite, one queued test per package, and the first package's task (returned for the caller
 * to enqueue). Run inside a transaction. Throws when the app has no active module.
 */
export async function startAppTestSuite(database: Database, i: SuiteInput): Promise<{ suiteId: string; packages: number; task: TaskRow }> {
  const modules = await database
    .select({ id: appModules.id, name: appModules.name })
    .from(appModules)
    .where(and(eq(appModules.appId, i.app.id), eq(appModules.workspaceId, i.workspaceId), isNull(appModules.hold)))
    .orderBy(asc(appModules.position), asc(appModules.createdAt));
  const packages = planSuitePackages(modules);
  if (!packages.length) throw new Error("the app has no active module");
  const [suite] = await database
    .insert(appTestSuites)
    .values({ workspaceId: i.workspaceId, appId: i.app.id, environmentId: i.environmentId, employeeId: i.employeeId, focus: i.focus, roles: i.roles, createdBy: i.createdBy })
    .returning();
  const tests = await database
    .insert(appTests)
    .values(
      packages.map((p, n) => ({
        workspaceId: i.workspaceId,
        appId: i.app.id,
        environmentId: i.environmentId,
        commit: i.commit,
        status: "queued" as AppTestStatus,
        focus: i.focus,
        roles: i.roles,
        suiteId: suite!.id,
        position: n,
        title: p.title,
        moduleIds: p.moduleIds,
        createdBy: i.createdBy,
      })),
    )
    .returning();
  const first = tests.find((t) => t.position === 0)!;
  const task = await startPackage(database, suite!, first, packages.length, i.app);
  return { suiteId: suite!.id, packages: packages.length, task };
}

export interface SuiteEnd {
  suiteId: string;
  workspaceId: string;
  appId: string;
  appName: string;
  packages: number;
  findings: { high: number; medium: number; low: number };
  /** packages that ended without a report or never ran */
  failed: number;
}

/**
 * After a task ended: when it was a package of a running suite, start the next queued package (returned to enqueue),
 * or end the suite after the last one (returned as `ended`, for one summary). `inSuite` tells the caller not to notify
 * this package's end on its own. Call after the test was settled (settleAppTest).
 */
export async function advanceAppTestSuite(
  database: DB,
  taskId: string,
  appOf: (appId: string) => Promise<SuiteApp | null>,
): Promise<{ inSuite: boolean; task: TaskRow | null; ended: SuiteEnd | null }> {
  const [cur] = await database.select({ suiteId: appTests.suiteId }).from(appTests).where(eq(appTests.taskId, taskId));
  if (!cur?.suiteId) return { inSuite: false, task: null, ended: null };
  const suiteId = cur.suiteId;
  const cancelQueued = (tx: Database) =>
    tx.update(appTests).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(appTests.suiteId, suiteId), eq(appTests.status, "queued")));
  return database.transaction(async (tx) => {
    await lockSuite(tx, suiteId);
    const [suite] = await tx.select().from(appTestSuites).where(eq(appTestSuites.id, suiteId));
    if (!suite || suite.status !== "running") return { inSuite: true, task: null, ended: null };
    const tests = await tx.select().from(appTests).where(eq(appTests.suiteId, suiteId)).orderBy(asc(appTests.position));
    // another package already runs (this end was handed over before): nothing to start
    if (tests.some((t) => t.status === "running" && t.taskId !== taskId)) return { inSuite: true, task: null, ended: null };
    const next = tests.find((t) => t.status === "queued");
    const app = await appOf(suite.appId);
    if (next) {
      try {
        if (!app || !suite.employeeId) throw new Error("the app or its tester is gone");
        const task = await tx.transaction((sp) => startPackage(sp, suite, next, tests.length, app));
        return { inSuite: true, task, ended: null };
      } catch {
        // the tester was archived or removed: the rest cannot run
        await cancelQueued(tx);
      }
    }
    await tx.update(appTestSuites).set({ status: "done", finishedAt: new Date() }).where(eq(appTestSuites.id, suiteId));
    const done = await tx.select().from(appTests).where(eq(appTests.suiteId, suiteId));
    const findings = { high: 0, medium: 0, low: 0 };
    for (const t of done) for (const f of t.findings) findings[f.severity] += 1;
    return {
      inSuite: true,
      task: null,
      ended: {
        suiteId,
        workspaceId: suite.workspaceId,
        appId: suite.appId,
        appName: app?.name ?? "",
        packages: done.length,
        findings,
        failed: done.filter((t) => t.status === "error" || t.status === "cancelled").length,
      },
    };
  });
}

/** Stop a full test: packages not started yet are cancelled; the running one finishes. False: it was not running. */
export async function stopAppTestSuite(database: DB, workspaceId: string, suiteId: string): Promise<boolean> {
  return database.transaction(async (tx) => {
    await lockSuite(tx, suiteId);
    const [s] = await tx
      .update(appTestSuites)
      .set({ status: "stopped", finishedAt: new Date() })
      .where(and(eq(appTestSuites.id, suiteId), eq(appTestSuites.workspaceId, workspaceId), eq(appTestSuites.status, "running")))
      .returning({ id: appTestSuites.id });
    if (!s) return false;
    await tx.update(appTests).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(appTests.suiteId, suiteId), eq(appTests.status, "queued")));
    return true;
  });
}
