import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, type DB } from "./index";
import { agentWorkOnRepository, type AgentWork } from "./agent-work";
import { createTask, type TaskRow } from "./tasks";
import { appDocuments, appEnvironments, appModules, appModuleTasks, appReleases, apps, tasks, type AppModuleHold, type AppModulePendingWork, type AppModuleTaskRole } from "./schema";

/**
 * C8: an app's modules. A module is a part of the app built from its own PRD in the app's repository and released
 * with the app. Its status is never typed in: it is read from its tasks (and their subtasks), what was pushed and
 * merged for them, and whether the commit running in the preview / LIVE contains that work (app_releases.modules).
 * One module build or change runs per app at a time; a request made meanwhile waits on the module (pending_work).
 */

export const MODULE_SLUG = /^[a-z][a-z0-9-]{1,39}$/;

/** "Laporan Keuangan" -> "laporan-keuangan" (the technical name a person can still edit) */
export function moduleSlug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const slug = /^[a-z]/.test(s) ? s : `m-${s}`.slice(0, 40).replace(/-+$/, "");
  return MODULE_SLUG.test(slug) ? slug : "modul";
}

export type AppModuleStatus = "draft" | "ready" | "building" | "in_review" | "merged" | "live" | AppModuleHold;

const ACTIVE: ("QUEUED" | "RUNNING" | "AWAITING_APPROVAL")[] = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"];
const isActive = (s: string) => (ACTIVE as string[]).includes(s);
const WORK_ROLES: AppModuleTaskRole[] = ["build", "change"];

export interface AppModuleTaskRef {
  taskId: string;
  title: string;
  role: AppModuleTaskRole;
  status: string;
  createdAt: Date;
}

export interface AppModuleView {
  id: string;
  slug: string;
  name: string;
  summary: string;
  position: number;
  hold: AppModuleHold | null;
  status: AppModuleStatus;
  prd: { approved: { id: string; version: number } | null; draft: { id: string; version: number } | null };
  /** a task is writing (a new version of) the PRD */
  writingPrd: boolean;
  /** the build or change running now */
  active: AppModuleTaskRef | null;
  pending: AppModulePendingWork | null;
  tasks: AppModuleTaskRef[];
  /** pushed work of its tasks and subtasks, newest first */
  work: Pick<AgentWork, "taskId" | "title" | "branch" | "head" | "pushedAt" | "state">[];
  inPreview: boolean;
  inLive: boolean;
  createdAt: Date;
}

type Database = Pick<DB, "select" | "insert" | "update" | "execute">;

/** every task under the given ones (subtasks of a team build), mapped to the linked task it descends from */
export async function moduleTaskTree(database: Pick<DB, "execute">, rootIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rootIds.length) return out;
  const roots = sql.join(
    rootIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await database.execute<{ id: string; root: string }>(sql`
    WITH RECURSIVE t(id, root) AS (
      SELECT id, id FROM tasks WHERE id IN (${roots})
      UNION ALL
      SELECT c.id, t.root FROM tasks c JOIN t ON c.parent_task_id = t.id
    ) SELECT id::text AS id, root::text AS root FROM t`);
  for (const r of rows) out.set(r.id, r.root);
  return out;
}

/** The modules of an app (or one of them) with their derived status, newest work first. */
export async function appModuleViews(workspaceId: string, appId: string, opts: { moduleId?: string } = {}): Promise<AppModuleView[]> {
  const db = getDb();
  const [app] = await db.select({ repositoryId: apps.repositoryId }).from(apps).where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId)));
  if (!app) return [];
  const mods = await db
    .select()
    .from(appModules)
    .where(and(eq(appModules.appId, appId), eq(appModules.workspaceId, workspaceId), opts.moduleId ? eq(appModules.id, opts.moduleId) : undefined))
    .orderBy(asc(appModules.position), asc(appModules.createdAt));
  if (!mods.length) return [];
  const ids = mods.map((m) => m.id);
  const links = await db
    .select({ moduleId: appModuleTasks.moduleId, taskId: tasks.id, title: tasks.title, role: appModuleTasks.role, status: tasks.status, createdAt: tasks.createdAt })
    .from(appModuleTasks)
    .innerJoin(tasks, eq(tasks.id, appModuleTasks.taskId))
    .where(inArray(appModuleTasks.moduleId, ids))
    .orderBy(desc(tasks.createdAt));
  const tree = await moduleTaskTree(
    db,
    links.filter((l) => l.role !== "prd").map((l) => l.taskId),
  );
  const moduleOfRoot = new Map(links.map((l) => [l.taskId, l.moduleId]));
  const works = app.repositoryId && tree.size ? await agentWorkOnRepository(workspaceId, app.repositoryId, { taskIds: [...tree.keys()] }) : [];
  const docs = await db
    .select({ id: appDocuments.id, moduleId: appDocuments.moduleId, version: appDocuments.version, status: appDocuments.status })
    .from(appDocuments)
    .where(and(inArray(appDocuments.moduleId, ids), eq(appDocuments.kind, "prd"), inArray(appDocuments.status, ["approved", "draft"])))
    .orderBy(desc(appDocuments.version));
  const envs = await db
    .select({ kind: appEnvironments.kind, modules: appReleases.modules })
    .from(appEnvironments)
    .leftJoin(appReleases, eq(appReleases.id, appEnvironments.currentReleaseId))
    .where(eq(appEnvironments.appId, appId));
  const contained = (kind: string) => new Set(envs.find((e) => e.kind === kind)?.modules ?? []);
  const preview = contained("preview");
  const live = contained("live");

  return mods.map((m) => {
    const refs: AppModuleTaskRef[] = links.filter((l) => l.moduleId === m.id).map(({ moduleId: _, ...r }) => r);
    const active = refs.find((r) => WORK_ROLES.includes(r.role) && isActive(r.status)) ?? null;
    const work = works.filter((w) => moduleOfRoot.get(tree.get(w.taskId) ?? "") === m.id);
    const approved = docs.find((d) => d.moduleId === m.id && d.status === "approved") ?? null;
    const draft = docs.find((d) => d.moduleId === m.id && d.status === "draft") ?? null;
    const open = work.some((w) => w.state === "unmerged" || w.state === "pending" || w.state === "failed");
    const merged = work.some((w) => w.state === "merged");
    const inLive = live.has(m.id);
    const status: AppModuleStatus = m.hold ? m.hold : active ? "building" : open ? "in_review" : inLive ? "live" : merged ? "merged" : approved ? "ready" : "draft";
    return {
      id: m.id,
      slug: m.slug,
      name: m.name,
      summary: m.summary,
      position: m.position,
      hold: m.hold,
      status,
      prd: { approved: approved && { id: approved.id, version: approved.version }, draft: draft && { id: draft.id, version: draft.version } },
      writingPrd: refs.some((r) => r.role === "prd" && isActive(r.status)),
      active,
      pending: m.pendingWork,
      tasks: refs,
      work: work.map(({ taskId, title, branch, head, pushedAt, state }) => ({ taskId, title, branch, head, pushedAt, state })),
      inPreview: preview.has(m.id),
      inLive,
      createdAt: m.createdAt,
    };
  });
}

/** The module build or change running in this app now (one per app), if any. */
export async function activeModuleWork(database: Pick<DB, "select">, appId: string): Promise<{ taskId: string; moduleId: string; title: string } | null> {
  const [row] = await database
    .select({ taskId: tasks.id, moduleId: appModuleTasks.moduleId, title: tasks.title })
    .from(appModuleTasks)
    .innerJoin(appModules, eq(appModules.id, appModuleTasks.moduleId))
    .innerJoin(tasks, eq(tasks.id, appModuleTasks.taskId))
    .where(and(eq(appModules.appId, appId), inArray(appModuleTasks.role, WORK_ROLES), inArray(tasks.status, ACTIVE)))
    .limit(1);
  return row ?? null;
}

export interface ModuleWorkInput {
  workspaceId: string;
  app: { id: string; name: string; repositoryId: string | null; clientId: string | null; projectId: string | null };
  module: { id: string; name: string; slug: string };
  role: "build" | "change";
  employeeId: string | null;
  teamId: string | null;
  note: string;
  createdBy: string | null;
}

/** The task of a module build or change, linked to the module. The caller enqueues it. */
export async function startModuleWork(database: Database, i: ModuleWorkInput): Promise<TaskRow> {
  if (!i.app.repositoryId) throw new Error("the app has no repository");
  const what = i.role === "build" ? "Bangun modul" : "Ubah modul";
  const brief =
    i.role === "build"
      ? `Build the module "${i.module.name}" (${i.module.slug}) of ${i.app.name} in the app's repository, as its approved PRD says (given below as data).`
      : `Change the module "${i.module.name}" (${i.module.slug}) of ${i.app.name} in the app's repository, as the request below says. Keep to the module's approved PRD unless the request changes it; if it does, say in your summary what the PRD should change.`;
  const task = await createTask(database, {
    workspaceId: i.workspaceId,
    title: `${what}: ${i.module.name} (${i.app.name})`.slice(0, 200),
    brief: [brief, i.note ? `Request: ${i.note}` : ""].filter(Boolean).join("\n\n"),
    assigneeId: i.employeeId,
    teamId: i.teamId,
    clientId: i.app.clientId,
    projectId: i.app.projectId,
    repositoryId: i.app.repositoryId,
    source: "board",
    createdBy: i.createdBy,
  });
  await database.insert(appModuleTasks).values({ taskId: task.id, moduleId: i.module.id, workspaceId: i.workspaceId, role: i.role, createdBy: i.createdBy });
  return task;
}

/** serializes module work per app: the check "is a build running" and the start happen under this lock */
export async function lockAppModules(database: Pick<DB, "execute">, appId: string): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`wfos-modules:${appId}`}))`);
}

/**
 * A build or change of a module: started now when the app has none running, else kept on the module until the
 * running one ends (takeQueuedModuleWork). Run inside a transaction (the lock lasts until it ends).
 */
export async function requestModuleWork(database: Database, i: ModuleWorkInput): Promise<{ task: TaskRow | null; waitingFor: string | null }> {
  await lockAppModules(database, i.app.id);
  const running = await activeModuleWork(database, i.app.id);
  if (!running) {
    await database.update(appModules).set({ pendingWork: null, updatedAt: new Date() }).where(eq(appModules.id, i.module.id));
    return { task: await startModuleWork(database, i), waitingFor: null };
  }
  const pending: AppModulePendingWork = { role: i.role, employeeId: i.employeeId, teamId: i.teamId, note: i.note, requestedBy: i.createdBy, requestedAt: new Date().toISOString() };
  await database.update(appModules).set({ pendingWork: pending, updatedAt: new Date() }).where(eq(appModules.id, i.module.id));
  return { task: null, waitingFor: running.title };
}

/**
 * After a module task ended: start the oldest waiting build or change of that app (none while another runs, or for a
 * module on hold). Returns the started task for the caller to enqueue.
 */
export async function takeQueuedModuleWork(
  database: DB,
  workspaceId: string,
  appId: string,
): Promise<{ task: TaskRow | null; dropped: { moduleId: string; error: string } | null }> {
  return database.transaction(async (tx) => {
    await lockAppModules(tx, appId);
    if (await activeModuleWork(tx, appId)) return { task: null, dropped: null };
    const [m] = await tx
      .select()
      .from(appModules)
      .where(and(eq(appModules.appId, appId), eq(appModules.workspaceId, workspaceId), isNotNull(appModules.pendingWork), isNull(appModules.hold)))
      .orderBy(sql`${appModules.pendingWork}->>'requestedAt'`)
      .limit(1);
    if (!m?.pendingWork) return { task: null, dropped: null };
    const [app] = await tx.select().from(apps).where(eq(apps.id, appId));
    // taken off the module first: a request that cannot start (archived employee, removed repository) must not
    // block the ones behind it; the caller reports it
    await tx.update(appModules).set({ pendingWork: null, updatedAt: new Date() }).where(eq(appModules.id, m.id));
    const p = m.pendingWork;
    try {
      const task = await tx.transaction((sp) =>
        startModuleWork(sp, {
          workspaceId,
          app: { id: appId, name: app?.name ?? "", repositoryId: app?.repositoryId ?? null, clientId: app?.clientId ?? null, projectId: app?.projectId ?? null },
          module: { id: m.id, name: m.name, slug: m.slug },
          role: p.role,
          employeeId: p.employeeId,
          teamId: p.teamId,
          note: p.note,
          createdBy: p.requestedBy,
        }),
      );
      return { task, dropped: null };
    } catch (e) {
      return { task: null, dropped: { moduleId: m.id, error: e instanceof Error ? e.message : String(e) } };
    }
  });
}

/** The app of a task linked to a module (any role), for the worker's end-of-task hook. */
export async function moduleAppOfTask(taskId: string): Promise<{ appId: string; workspaceId: string } | null> {
  const [row] = await getDb()
    .select({ appId: appModules.appId, workspaceId: appModules.workspaceId })
    .from(appModuleTasks)
    .innerJoin(appModules, eq(appModules.id, appModuleTasks.moduleId))
    .where(eq(appModuleTasks.taskId, taskId));
  return row ?? null;
}
