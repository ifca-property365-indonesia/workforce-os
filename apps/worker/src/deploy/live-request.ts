import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { appEnvironments, approvals, apps, appReleases, audit, auditLog, db, tasks, users } from "@wfos/db";
import { requestReleasePayloadSchema, type AppManifest, type RequestReleasePayload } from "@wfos/shared";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { deploysQueue } from "../lib/redis";
import { mirrorPath } from "../runner/workspace/git";
import { appUrl, environmentOf, isOwner, publishRelease, sha8, type App, type Environment, type Release } from "./common";
import { commitSubject, DeployInputError, readManifest, releaseWarnings } from "./manifest";
import { ACTIVE_RELEASE_STATUSES, changesSince, commitExists, rangeStart, storedManifest, type PreviewActionResult } from "./preview";
import { describeWindow, outsideWindowMessage } from "./window";

/**
 * Phase B3: a Developer proposes releasing a preview version that already ran to the app's LIVE environment
 * (request_release). Only an Owner can approve it (the web asks for a fresh step-up); the executor
 * (queueLiveRelease) re-checks everything and queues a LIVE release promoted from that preview release; prepare then
 * accepts it only because an Owner decided the approval (ownerApprovedLiveRelease in the pipeline).
 */

/** a preview release whose commit ran (now or before): the only versions that may go LIVE */
export const PROMOTABLE_STATUSES = ["deployed", "superseded"] as const;
/** an approved request_release older than this is never executed: LIVE and the preview may have moved on */
export const RELEASE_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * A request_release refused for a reason that is not the Developer's code (the window is closed, the request went
 * stale): it never counts toward the failed-attempt cap. executionResult.details.uncounted marks it.
 */
const uncounted = (summary: string): PreviewActionResult => ({ ok: false, summary, details: { uncounted: true } });
const promotable = (r: Pick<Release, "status">) => (PROMOTABLE_STATUSES as readonly string[]).includes(r.status);

/**
 * LIVE env names changed (added, changed, removed) since the release LIVE runs now started: the `app.env_updated`
 * audit entries of that environment, names only. The same source as the web's liveEnvChanges.
 */
export async function liveEnvChanges(workspaceId: string, appId: string, live: Pick<Environment, "id" | "currentReleaseId">): Promise<string[]> {
  if (!live.currentReleaseId) return [];
  const [cur] = await db.select({ startedAt: appReleases.startedAt, createdAt: appReleases.createdAt }).from(appReleases).where(eq(appReleases.id, live.currentReleaseId));
  if (!cur) return [];
  const rows = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.targetId, appId),
        eq(auditLog.action, "app.env_updated"),
        gt(auditLog.createdAt, cur.startedAt ?? cur.createdAt),
        sql`${auditLog.details}->>'environmentId' = ${live.id}`,
      ),
    );
  const names = new Set<string>();
  for (const { details } of rows) {
    for (const k of ["added", "changed", "removed"]) {
      const v = (details ?? {})[k];
      if (Array.isArray(v)) for (const n of v) if (typeof n === "string") names.add(n);
    }
  }
  return [...names].sort();
}

export type LiveReleaseRequest = { error: string } | { payload: RequestReleasePayload; app: App; live: Environment };

/**
 * request_release, before the gate: the app must belong to the workspace, be linked to the task's repository and
 * have a LIVE environment; the version is a preview release of that app that deployed (deployed or superseded),
 * by default the one the preview runs now. The payload compares it with what LIVE runs now.
 */
export async function buildLiveReleaseRequest(o: {
  workspaceId: string;
  repo: { id: string; name: string; defaultBranch: string };
  appId: string;
  fromReleaseId?: string | null;
  summary: string;
}): Promise<LiveReleaseRequest> {
  const [app] = await db.select().from(apps).where(and(eq(apps.id, o.appId), eq(apps.workspaceId, o.workspaceId)));
  if (!app) return { error: "App not found in this workspace (see list_apps)." };
  if (app.repositoryId !== o.repo.id) {
    return { error: `App "${app.name}" is not linked to your repository ${o.repo.name}: you can only propose releases of an app built from the repository of this task (see list_apps).` };
  }
  const live = await environmentOf(app.id, "live");
  if (!live) return { error: `App "${app.name}" has no LIVE environment: an Owner sets it up first (Apps → the app → Set up LIVE). Nothing was requested.` };
  const preview = await environmentOf(app.id, "preview");
  if (!preview) return { error: `App "${app.name}" has no preview environment; ask an Admin to check the app.` };

  let from: Release | undefined;
  if (o.fromReleaseId) {
    [from] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.id, o.fromReleaseId), eq(appReleases.workspaceId, o.workspaceId), eq(appReleases.appId, app.id), eq(appReleases.environmentId, preview.id)));
    if (!from) return { error: `Release ${o.fromReleaseId} is not a release of the preview of "${app.name}": only a version that ran in the preview can go LIVE (list_apps shows the preview's current release).` };
  } else {
    if (!preview.currentReleaseId) return { error: `The preview of "${app.name}" runs no version yet: publish it with request_preview first and wait until the platform reports it deployed.` };
    [from] = await db.select().from(appReleases).where(eq(appReleases.id, preview.currentReleaseId));
    if (!from) return { error: `The preview of "${app.name}" runs no version yet: publish it with request_preview first.` };
  }
  if (!promotable(from) || !from.commit) {
    return { error: `Release ${from.id} of the preview is ${from.status}: only a preview version that deployed can go LIVE. Wait until the platform reports the preview deployed, then call request_release again.` };
  }
  const [current] = live.currentReleaseId ? await db.select().from(appReleases).where(eq(appReleases.id, live.currentReleaseId)) : [];
  if (current && current.commit === from.commit && live.status === "running") {
    return { error: `LIVE already runs commit ${sha8(from.commit)} at ${appUrl(live)}: there is nothing new to release.` };
  }

  const mirror = mirrorPath(o.repo.id);
  if (!(await commitExists(mirror, from.commit))) return { error: `Commit ${sha8(from.commit)} is not in the platform's copy of ${o.repo.name}; ask an Admin to check the repository.` };
  let manifest: AppManifest | null = storedManifest(from.manifest);
  if (!manifest) {
    try {
      manifest = await readManifest(mirror, from.commit);
    } catch (e) {
      if (e instanceof DeployInputError) return { error: `${e.message} (commit ${sha8(from.commit)}).` };
      throw e;
    }
  }
  const start = await rangeStart(mirror, from.commit, current?.commit ?? null, o.repo.defaultBranch);
  const changes = await changesSince(mirror, start, from.commit);
  const warnings = await releaseWarnings({
    mirror,
    sha: from.commit,
    manifest,
    current: current ? { commit: current.commit, manifest: storedManifest(current.manifest) } : null,
    hasDatabase: !!live.dbPasswordEnc,
    accessMode: live.accessMode,
  });
  const payload = requestReleasePayloadSchema.parse({
    appId: app.id,
    appName: app.name,
    environmentId: live.id,
    url: appUrl(live),
    fromReleaseId: from.id,
    commit: from.commit,
    commitSubject: from.commitSubject ?? ((await commitSubject(mirror, from.commit)) || null),
    currentCommit: current?.commit ?? null,
    ...changes,
    warnings,
    migrations: manifest.migrations,
    database: manifest.database,
    liveEnvChanged: await liveEnvChanges(o.workspaceId, app.id, live),
    releaseWindow: live.releaseWindow ?? null,
    summary: o.summary.slice(0, 2000),
  });
  return { payload, app, live };
}

/** Plain text of a LIVE release request (draft deliverable, dry-run record). */
export function liveReleaseRequestText(p: RequestReleasePayload): string {
  return [
    `LIVE release of ${p.appName} at ${p.url}: commit ${p.commit}${p.commitSubject ? ` "${p.commitSubject}"` : ""} (preview release ${p.fromReleaseId})`,
    p.currentCommit ? `LIVE runs now: ${p.currentCommit}` : "First LIVE release",
    p.commits.length ? `Commits:\n${p.commits.map((c) => `- ${sha8(c.sha)} ${c.subject}`).join("\n")}` : "",
    p.files.length ? `Files:\n${p.files.map((f) => `- ${f.path} (+${f.added} -${f.removed})`).join("\n")}${p.filesTruncated ? "\n- …" : ""}` : "",
    `Migrations: ${p.migrations}${p.database ? " (the database is backed up first)" : " (no database)"}`,
    p.warnings.length ? `Warnings: ${p.warnings.join(", ")}` : "",
    p.liveEnvChanged.length ? `LIVE environment variables changed since the running release: ${p.liveEnvChanged.join(", ")}` : "",
    p.releaseWindow ? `Release window: ${describeWindow(p.releaseWindow)}` : "",
    "Only an Owner can approve a LIVE release.",
    p.summary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The approved request_release: the approval must have been decided by an OWNER of the workspace and not edited; the
 * task, app, LIVE environment and the preview release are checked again (it must still be a deployed or superseded
 * release of the app's preview with that commit); outside the release window nothing is queued; then a LIVE release
 * `{ trigger: "approval", approvalId, taskId, commit, promotedFromReleaseId, createdBy: decidedBy }` is queued. The
 * pipeline re-checks the DNS, the kill switch, the dry run, the window and the approval itself.
 */
export async function queueLiveRelease(workspaceId: string, raw: Record<string, unknown>, context: { taskId?: string | null; approvalId?: string | null }): Promise<PreviewActionResult> {
  if (!context.taskId || !context.approvalId) return { ok: false, summary: "A LIVE release is only queued from an approved request of a task." };
  const parsed = requestReleasePayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, summary: `Invalid LIVE release request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500)}` };
  const p = parsed.data;
  const taskId = context.taskId;
  const [a] = await db
    .select({ decidedBy: approvals.decidedBy, edited: approvals.editedPayload, toolName: approvals.toolName, taskId: approvals.taskId, createdAt: approvals.createdAt })
    .from(approvals)
    .where(and(eq(approvals.id, context.approvalId), eq(approvals.workspaceId, workspaceId)));
  if (!a || a.toolName !== "request_release" || a.taskId !== taskId) return { ok: false, summary: "The LIVE release request was not found: nothing was released." };
  // the Owner saw exactly this version and diff: an edited request (the web refuses edits) is never released
  if (a.edited) return { ok: false, summary: "A LIVE release request cannot be edited before approval: nothing was released. Ask the Developer for a new request." };
  if (!(await isOwner(workspaceId, a.decidedBy))) return { ok: false, summary: "Only an Owner of the workspace can approve a LIVE release: nothing was released." };
  const createdBy = a.decidedBy!;
  if (Date.now() - a.createdAt.getTime() > RELEASE_REQUEST_MAX_AGE_MS) {
    return uncounted("The LIVE release request is older than 24 hours: nothing was released. Ask again (request_release) so the Owner approves what LIVE and the preview are now.");
  }

  const [task] = await db.select({ repositoryId: tasks.repositoryId }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
  const [app] = await db.select().from(apps).where(and(eq(apps.id, p.appId), eq(apps.workspaceId, workspaceId)));
  if (!app) return { ok: false, summary: "The app no longer exists: nothing was released." };
  if (!task || !app.repositoryId || task.repositoryId !== app.repositoryId) return { ok: false, summary: `The task is no longer connected to the repository of "${app.name}": nothing was released.` };
  const live = await environmentOf(app.id, "live");
  if (!live || live.id !== p.environmentId) return { ok: false, summary: `App "${app.name}" no longer has that LIVE environment: nothing was released.` };
  const preview = await environmentOf(app.id, "preview");
  const outside = outsideWindowMessage(live.releaseWindow);
  if (outside) return uncounted(`The LIVE release was not queued (the release window is closed): ${outside}`);
  if (live.statusMessage === "restoring") return { ok: false, summary: `A database restore of "${app.name}" (LIVE) is running: nothing was released. Request the release again once it has finished.` };

  const queued = await db.transaction(async (tx) => {
    // the environment row is the lock (as for a release from the web): two approvals at once cannot both see "nothing running"
    await tx.select({ id: appEnvironments.id }).from(appEnvironments).where(eq(appEnvironments.id, live.id)).for("update");
    const [from] = preview
      ? await tx
          .select()
          .from(appReleases)
          .where(and(eq(appReleases.id, p.fromReleaseId), eq(appReleases.environmentId, preview.id), eq(appReleases.appId, app.id), inArray(appReleases.status, ["deployed", "superseded"])))
      : [];
    if (!from || from.commit !== p.commit) return { kind: "gone" as const };
    // the Owner approved a diff against what LIVE ran at request time: LIVE must still run exactly that
    const [lockedLive] = await tx.select({ currentReleaseId: appEnvironments.currentReleaseId }).from(appEnvironments).where(eq(appEnvironments.id, live.id));
    const [cur] = lockedLive?.currentReleaseId ? await tx.select({ commit: appReleases.commit }).from(appReleases).where(eq(appReleases.id, lockedLive.currentReleaseId)) : [];
    const nowCommit = cur?.commit || null;
    if (nowCommit !== p.currentCommit) return { kind: "stale" as const, nowCommit };
    const [active] = await tx
      .select({ id: appReleases.id, status: appReleases.status })
      .from(appReleases)
      .where(and(eq(appReleases.environmentId, live.id), inArray(appReleases.status, [...ACTIVE_RELEASE_STATUSES])))
      .limit(1);
    if (active) return { kind: "busy" as const, active };
    const [r] = await tx
      .insert(appReleases)
      .values({
        appId: app.id,
        environmentId: live.id,
        workspaceId,
        commit: from.commit,
        branch: from.branch,
        commitSubject: from.commitSubject,
        manifest: from.manifest,
        status: "queued",
        trigger: "approval",
        approvalId: context.approvalId,
        taskId,
        promotedFromReleaseId: from.id,
        createdBy,
      })
      .returning();
    return { kind: "queued" as const, release: r! };
  });
  if (queued.kind === "stale") {
    return uncounted(`LIVE changed since this request (now ${queued.nowCommit ? queued.nowCommit.slice(0, 7) : "nothing"}): nothing was released. Ask again (request_release) so the Owner sees the current difference.`);
  }
  if (queued.kind === "gone") {
    return { ok: false, summary: `Preview release ${p.fromReleaseId} (commit ${sha8(p.commit)}) is no longer a deployed version of the preview: nothing was released.` };
  }
  if (queued.kind === "busy") {
    return { ok: false, summary: `"${app.name}" (LIVE) already has a release ${queued.active.status} (release ${queued.active.id}): nothing was queued. Request the release again once it has finished.` };
  }
  const rel = queued.release;
  try {
    await deploysQueue.add("release", { kind: "release", releaseId: rel.id, workspaceId }, { jobId: rel.id });
  } catch (e) {
    log.error({ err: e, releaseId: rel.id }, "LIVE release could not be queued");
    await db.update(appReleases).set({ status: "failed", error: "could not be queued", finishedAt: new Date() }).where(eq(appReleases.id, rel.id));
    return { ok: false, summary: `The LIVE release could not be queued (${errorMessage(e).slice(0, 200)}): nothing was released.`, details: { releaseId: rel.id } };
  }
  await publishRelease(rel);
  const [who] = await db.select({ email: users.email }).from(users).where(eq(users.id, createdBy));
  await audit({
    workspaceId,
    actorUserId: createdBy,
    actorLabel: who?.email ?? "approval",
    action: "app.live_deploy_requested",
    targetType: "app",
    targetId: app.id,
    details: {
      name: app.name,
      environment: "live",
      environmentId: live.id,
      releaseId: rel.id,
      branch: rel.branch,
      commit: rel.commit,
      promotedFromReleaseId: rel.promotedFromReleaseId,
      domain: live.domain,
      trigger: "approval",
      approvalId: context.approvalId,
      taskId,
    },
  });
  return { ok: true, summary: `LIVE release queued: release ${rel.id}`, details: { releaseId: rel.id, appId: app.id, environmentId: live.id, commit: rel.commit, url: appUrl(live) } };
}
