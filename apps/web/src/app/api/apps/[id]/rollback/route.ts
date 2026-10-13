import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appReleases, apps, audit, db, servers } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { activeRelease, assertDeploysAllowed, isUuid, loadApp, releaseDTO, ROLLBACK_SOURCE_STATUSES } from "@/lib/server/apps";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";

const rollbackSchema = z.object({ releaseId: z.string() });

/**
 * Bring back the commit of an earlier release that ran (deployed or superseded) as a new release with trigger
 * rollback. The database is not restored automatically.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const { releaseId } = await body(req, rollbackSchema);
  await assertDeploysAllowed(session.workspaceId);
  const [src] = isUuid(releaseId) ? await db.select().from(appReleases).where(and(eq(appReleases.id, releaseId), eq(appReleases.appId, a.id))) : [];
  if (!src) throw new HttpError(404, "Release not found", { code: "release_not_found" });
  if (!(ROLLBACK_SOURCE_STATUSES as readonly string[]).includes(src.status) || !src.commit) {
    throw new HttpError(409, "Only a release that ran can be brought back", { code: "release_not_rollbackable" });
  }
  if (src.id === a.currentReleaseId) throw new HttpError(409, "This release is the one running now", { code: "release_is_current" });
  const [server] = await db.select({ status: servers.status }).from(servers).where(eq(servers.id, a.serverId));
  if (server?.status !== "ready") throw new HttpError(409, "The server is not ready", { code: "server_not_ready" });
  const release = await db.transaction(async (tx) => {
    await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, a.id)).for("update");
    if (await activeRelease(a.id, tx)) throw new HttpError(409, "A deploy of this app is already running", { code: "app_deploy_running" });
    const [r] = await tx
      .insert(appReleases)
      .values({
        appId: a.id,
        workspaceId: session.workspaceId,
        commit: src.commit,
        branch: src.branch,
        commitSubject: src.commitSubject,
        manifest: src.manifest,
        status: "queued",
        trigger: "rollback",
        rollbackOfId: src.id,
        createdBy: session.userId,
      })
      .returning();
    return r!;
  });
  await q.deploy({ kind: "release", releaseId: release.id, workspaceId: session.workspaceId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.rollback_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, releaseId: release.id, rollbackOfId: src.id, commit: src.commit },
  });
  await publish(session.workspaceId, { type: "release.updated", releaseId: release.id, appId: a.id, status: release.status, step: null });
  return { release: releaseDTO(release, session.name) };
});
