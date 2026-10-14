import { and, desc, eq, inArray } from "drizzle-orm";
import { appEnvironments, approvals, apps, appReleases, audit, db, repositories, servers, tasks, users } from "@wfos/db";
import { requestPreviewPayloadSchema, type AppManifest, type RequestPreviewPayload } from "@wfos/shared";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { deploysQueue } from "../lib/redis";
import { agentBranch, mirrorPath, rootGit, SAFE_REF } from "../runner/workspace/git";
import { appUrl, environmentOf, publishRelease, sha8, type App, type Environment } from "./common";
import { commitSubject, DeployInputError, parseManifest, readManifest, releaseWarnings } from "./manifest";

/**
 * Phase A3: a Developer publishes the branch it pushed (git_push) as a preview of an app. The tool (registry
 * request_preview) builds the approval payload from the platform mirror; after a person approves, the executor
 * (queuePreviewRelease) queues a release of exactly that commit, and the deploy pipeline does the rest.
 */

/** release statuses a person (or a task) is still waiting for */
export const ACTIVE_RELEASE_STATUSES = ["queued", "deploying"] as const;
/** a preview that did not go live (the task goes back to the Developer) */
export const FAILED_RELEASE_STATUSES = ["failed", "rolled_back"] as const;

const MAX_COMMITS = 50;
const MAX_FILES = 300;
const SHA_RE = /^[0-9a-f]{40}$/;

/** The head of refs/agent/<task> in the mirror (what git_push exported), or null when there is none. */
export async function agentHead(repoId: string, taskId: string): Promise<string | null> {
  const sha = (await rootGit(["-C", mirrorPath(repoId), "rev-parse", "--verify", "--quiet", `refs/agent/${taskId}^{commit}`]).catch(() => "")).trim();
  return SHA_RE.test(sha) ? sha : null;
}

async function commitExists(mirror: string, sha: string): Promise<boolean> {
  return SHA_RE.test(sha) && (await rootGit(["-C", mirror, "cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false));
}

/**
 * Where the payload's commits and files start: the commit that runs now (when it is still in the mirror), else the
 * merge base with the default branch (a first preview), else nothing (every commit of the branch).
 */
async function rangeStart(mirror: string, head: string, current: string | null, defaultBranch: string): Promise<string | null> {
  if (current && (await commitExists(mirror, current))) return current;
  if (!SAFE_REF.test(defaultBranch)) return null;
  const base = (await rootGit(["-C", mirror, "merge-base", `refs/heads/${defaultBranch}`, head]).catch(() => "")).trim();
  return SHA_RE.test(base) ? base : null;
}

async function changesSince(mirror: string, from: string | null, head: string) {
  const range = from ? `${from}..${head}` : head;
  const commits = (await rootGit(["-C", mirror, "log", `--max-count=${MAX_COMMITS}`, "--format=%H%x09%s", range]))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41).slice(0, 300) }));
  // a first preview without a base: the whole tree is "added"
  const diffArgs = from ? [from, head] : ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", head];
  const all = (await rootGit(["-C", mirror, "diff", "--no-ext-diff", "--no-textconv", "--numstat", ...diffArgs], { maxBuffer: 64 * 1024 * 1024 }))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split("\t");
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(d) || 0 };
    });
  return { commits, files: all.slice(0, MAX_FILES), filesTruncated: all.length > MAX_FILES };
}

/** The validated, stored manifest of a release (null when it has none or it no longer parses). */
function storedManifest(m: unknown): AppManifest | null {
  try {
    return m ? parseManifest(m) : null;
  } catch {
    return null;
  }
}

export type PreviewRequest = { error: string } | { payload: RequestPreviewPayload; app: App; environment: Environment };

/**
 * request_preview, before the gate: the app must belong to the workspace and be linked to the task's repository,
 * it must have a preview environment whose server exists (agents only ever act on the preview, never on live), and the commit is the pushed head of agent/<task>, which must be the head of an EXECUTED
 * git_push of this task (`requirePushed`: false only in a dry run, where nothing is pushed or deployed).
 */
export async function buildPreviewRequest(o: {
  workspaceId: string;
  taskId: string;
  repo: { id: string; name: string; defaultBranch: string };
  appId: string;
  summary: string;
  requirePushed: boolean;
}): Promise<PreviewRequest> {
  const [app] = await db.select().from(apps).where(and(eq(apps.id, o.appId), eq(apps.workspaceId, o.workspaceId)));
  if (!app) return { error: "App not found in this workspace (see list_apps)." };
  if (app.repositoryId !== o.repo.id) {
    return { error: `App "${app.name}" is not linked to your repository ${o.repo.name}: you can only preview an app built from the repository of this task (see list_apps, linkedToYourRepository).` };
  }
  const environment = await environmentOf(app.id, "preview");
  if (!environment) return { error: `App "${app.name}" has no preview environment; ask an Admin to check the app.` };
  const [server] = await db.select({ name: servers.name }).from(servers).where(and(eq(servers.id, environment.serverId), eq(servers.workspaceId, o.workspaceId)));
  if (!server) return { error: `The server of app "${app.name}" no longer exists; ask an Admin to check the app.` };

  const notPushed = "Your branch is not pushed: push it first with git_push and wait for the approval, then call request_preview again.";
  const head = await agentHead(o.repo.id, o.taskId);
  if (!head) return { error: notPushed };
  if (o.requirePushed) {
    const pushes = await db
      .select({ payload: approvals.payload, editedPayload: approvals.editedPayload })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, o.workspaceId), eq(approvals.taskId, o.taskId), eq(approvals.toolName, "git_push"), eq(approvals.status, "EXECUTED")));
    const pushed = pushes.some((a) => {
      const p = (a.editedPayload ?? a.payload) as { head?: unknown; repositoryId?: unknown };
      return p.head === head && p.repositoryId === o.repo.id;
    });
    if (!pushed) {
      return { error: `Your latest commit ${sha8(head)} is not pushed yet: push it first with git_push and wait for the approval, then call request_preview again.` };
    }
  }

  const mirror = mirrorPath(o.repo.id);
  let manifest: AppManifest;
  try {
    manifest = await readManifest(mirror, head);
  } catch (e) {
    if (e instanceof DeployInputError) return { error: `${e.message}. Fix wfos-app.json (see the app-nextjs skill), commit, git_push again, then request_preview again.` };
    throw e;
  }
  const [current] = environment.currentReleaseId ? await db.select().from(appReleases).where(eq(appReleases.id, environment.currentReleaseId)) : [];
  if (current && current.commit === head) {
    return { error: `Commit ${sha8(head)} is already the version that runs at ${appUrl(environment)}: commit a change and push it before asking for a new preview.` };
  }
  const from = await rangeStart(mirror, head, current?.commit ?? null, o.repo.defaultBranch);
  const changes = await changesSince(mirror, from, head);
  const warnings = await releaseWarnings({
    mirror,
    sha: head,
    manifest,
    current: current ? { commit: current.commit, manifest: storedManifest(current.manifest) } : null,
    hasDatabase: !!environment.dbPasswordEnc,
    accessMode: environment.accessMode,
  });
  const payload = requestPreviewPayloadSchema.parse({
    appId: app.id,
    appName: app.name,
    url: appUrl(environment),
    serverName: server.name,
    repositoryId: o.repo.id,
    repository: o.repo.name,
    branch: agentBranch(o.taskId),
    commit: head,
    commitSubject: (await commitSubject(mirror, head)) || null,
    currentCommit: current?.commit ?? null,
    ...changes,
    warnings,
    manifest,
    summary: o.summary.slice(0, 2000),
  });
  return { payload, app, environment };
}

/** Plain text of a preview request (draft deliverable, dry-run record). */
export function previewRequestText(p: RequestPreviewPayload): string {
  return [
    `Preview of ${p.appName} at ${p.url} (server ${p.serverName})`,
    `Branch ${p.branch}, commit ${p.commit}${p.commitSubject ? ` "${p.commitSubject}"` : ""}`,
    p.currentCommit ? `Runs now: ${p.currentCommit}` : "First preview",
    p.commits.length ? `Commits:\n${p.commits.map((c) => `- ${sha8(c.sha)} ${c.subject}`).join("\n")}` : "",
    p.files.length ? `Files:\n${p.files.map((f) => `- ${f.path} (+${f.added} -${f.removed})`).join("\n")}${p.filesTruncated ? "\n- …" : ""}` : "",
    p.warnings.length ? `Warnings: ${p.warnings.join(", ")}` : "",
    p.summary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface PreviewActionResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * The approved request_preview: re-check that agent/<task> still points at the approved commit and that the app's
 * preview has no deploy queued or running, then queue a release of that commit (trigger "approval") on the deploys queue. The
 * pipeline re-checks the kill switch, dry run, the server and its capacity.
 */
export async function queuePreviewRelease(workspaceId: string, raw: Record<string, unknown>, context: { taskId?: string | null; approvalId?: string | null }): Promise<PreviewActionResult> {
  if (!context.taskId || !context.approvalId) return { ok: false, summary: "A preview is only published from an approved request of a task." };
  const parsed = requestPreviewPayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, summary: `Invalid preview request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500)}` };
  const p = parsed.data;
  const taskId = context.taskId;
  const [task] = await db.select({ repositoryId: tasks.repositoryId }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
  if (!task || task.repositoryId !== p.repositoryId) return { ok: false, summary: "The task is no longer connected to that repository: nothing was deployed." };
  const [app] = await db.select().from(apps).where(and(eq(apps.id, p.appId), eq(apps.workspaceId, workspaceId)));
  if (!app) return { ok: false, summary: "The app no longer exists: nothing was deployed." };
  if (app.repositoryId !== p.repositoryId) return { ok: false, summary: `App "${app.name}" is no longer linked to ${p.repository}: nothing was deployed.` };
  const environment = await environmentOf(app.id, "preview");
  if (!environment) return { ok: false, summary: `App "${app.name}" has no preview environment: nothing was deployed.` };
  const [repo] = await db.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.id, p.repositoryId), eq(repositories.workspaceId, workspaceId)));
  if (!repo) return { ok: false, summary: "The repository no longer exists: nothing was deployed." };
  const head = await agentHead(repo.id, taskId);
  if (head !== p.commit) {
    return { ok: false, summary: `The branch moved since the request (requested ${sha8(p.commit)}, now ${head ? sha8(head) : "missing"}): nothing was deployed. Push again and request a new preview.` };
  }
  const [a] = await db.select({ decidedBy: approvals.decidedBy, edited: approvals.editedPayload }).from(approvals).where(eq(approvals.id, context.approvalId));
  // the approver saw exactly this commit and diff: an edited request (the web refuses edits) is never deployed
  if (a?.edited) return { ok: false, summary: "A preview request cannot be edited before approval: nothing was deployed. Ask the Developer for a new request." };
  const createdBy = a?.decidedBy ?? null;

  const queued = await db.transaction(async (tx) => {
    // the environment row is the lock (as for a manual deploy): two approvals at once cannot both see "nothing running"
    await tx.select({ id: appEnvironments.id }).from(appEnvironments).where(eq(appEnvironments.id, environment.id)).for("update");
    const [active] = await tx
      .select({ id: appReleases.id, status: appReleases.status })
      .from(appReleases)
      .where(and(eq(appReleases.environmentId, environment.id), inArray(appReleases.status, [...ACTIVE_RELEASE_STATUSES])))
      .limit(1);
    if (active) return { kind: "busy" as const, active };
    const [r] = await tx
      .insert(appReleases)
      .values({
        appId: app.id,
        environmentId: environment.id,
        workspaceId,
        commit: p.commit,
        branch: agentBranch(taskId),
        commitSubject: p.commitSubject,
        status: "queued",
        trigger: "approval",
        approvalId: context.approvalId,
        taskId,
        createdBy,
      })
      .returning();
    return { kind: "queued" as const, release: r! };
  });
  if (queued.kind === "busy") {
    return { ok: false, summary: `App "${app.name}" already has a deploy ${queued.active.status} (release ${queued.active.id}): nothing was queued. Request the preview again once it has finished.` };
  }
  const rel = queued.release;
  try {
    await deploysQueue.add("release", { kind: "release", releaseId: rel.id, workspaceId }, { jobId: rel.id });
  } catch (e) {
    log.error({ err: e, releaseId: rel.id }, "preview release could not be queued");
    await db.update(appReleases).set({ status: "failed", error: "could not be queued", finishedAt: new Date() }).where(eq(appReleases.id, rel.id));
    return { ok: false, summary: `The preview could not be queued (${errorMessage(e).slice(0, 200)}): nothing was deployed.`, details: { releaseId: rel.id } };
  }
  await publishRelease(rel);
  const [who] = createdBy ? await db.select({ email: users.email }).from(users).where(eq(users.id, createdBy)) : [];
  await audit({
    workspaceId,
    actorUserId: createdBy,
    actorLabel: who?.email ?? "approval",
    action: "app.deploy_requested",
    targetType: "app",
    targetId: app.id,
    details: { name: app.name, releaseId: rel.id, environmentId: environment.id, environment: "preview", branch: rel.branch, commit: rel.commit, trigger: "approval", approvalId: context.approvalId, taskId },
  });
  return { ok: true, summary: `Preview queued: release ${rel.id}`, details: { releaseId: rel.id, appId: app.id, environmentId: environment.id, commit: rel.commit, url: appUrl(environment) } };
}

/**
 * list_apps: the workspace's apps with their preview (what agents work on), without secrets, env names or passwords;
 * `live` is read-only information (url, status, the commit it runs), never something an agent can act on.
 */
export async function listApps(workspaceId: string, yourRepositoryId: string | null) {
  const rows = await db
    .select({ app: apps, repository: repositories.name })
    .from(apps)
    .leftJoin(repositories, eq(repositories.id, apps.repositoryId))
    .where(eq(apps.workspaceId, workspaceId))
    .orderBy(desc(apps.updatedAt));
  const envs = rows.length
    ? await db
        .select()
        .from(appEnvironments)
        .where(and(eq(appEnvironments.workspaceId, workspaceId), inArray(appEnvironments.appId, rows.map((r) => r.app.id))))
    : [];
  const envOf = (appId: string, kind: Environment["kind"]) => envs.find((e) => e.appId === appId && e.kind === kind) ?? null;
  const currentIds = envs.map((e) => e.currentReleaseId).filter((x): x is string => !!x);
  const current = currentIds.length
    ? await db
        .select({ id: appReleases.id, commit: appReleases.commit, subject: appReleases.commitSubject, status: appReleases.status, finishedAt: appReleases.finishedAt, createdAt: appReleases.createdAt })
        .from(appReleases)
        .where(and(eq(appReleases.workspaceId, workspaceId), inArray(appReleases.id, currentIds)))
    : [];
  const byId = new Map(current.map((r) => [r.id, r]));
  return rows.map(({ app: a, repository }) => {
    const preview = envOf(a.id, "preview");
    const live = envOf(a.id, "live");
    const c = preview?.currentReleaseId ? byId.get(preview.currentReleaseId) : undefined;
    const lc = live?.currentReleaseId ? byId.get(live.currentReleaseId) : undefined;
    return {
      id: a.id,
      name: a.name,
      slug: a.slug,
      url: preview ? appUrl(preview) : null,
      status: preview?.status ?? "new",
      healthy: preview?.healthy ?? null,
      repository: repository ?? null,
      repositoryId: a.repositoryId,
      branch: a.branch,
      linkedToYourRepository: !!yourRepositoryId && a.repositoryId === yourRepositoryId,
      currentRelease: c ? { commit: c.commit, subject: c.subject, status: c.status, at: (c.finishedAt ?? c.createdAt).toISOString() } : null,
      lastDeployedAt: preview?.lastDeployedAt?.toISOString() ?? null,
      // read-only: agents never deploy to, stop or change the live environment
      live: live ? { url: appUrl(live), status: live.status, version: lc?.commit ?? null } : null,
    };
  });
}
