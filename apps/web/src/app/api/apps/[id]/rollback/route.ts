import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appEnvironments, appReleases, audit, db } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import {
  activeRelease,
  assertNoRestore,
  assertDeploysAllowed,
  assertNotRemoving,
  assertServerReady,
  isUuid,
  loadAppEnv,
  releaseDTO,
  requireLiveOwner,
  ROLLBACK_SOURCE_STATUSES,
} from "@/lib/server/apps";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";

const rollbackSchema = z.object({ releaseId: z.string() });

/**
 * Bring back the commit of an earlier release of the same environment that ran (deployed or superseded) as a new
 * release with trigger rollback. `?env=live` is the Owner's, with a fresh step-up. The database is not restored
 * automatically.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") await requireLiveOwner(session);
  const { releaseId } = await body(req, rollbackSchema);
  await assertDeploysAllowed(session.workspaceId);
  await assertNotRemoving(a.id);
  const [src] = isUuid(releaseId)
    ? await db
        .select()
        .from(appReleases)
        .where(and(eq(appReleases.id, releaseId), eq(appReleases.appId, a.id), eq(appReleases.environmentId, env.id)))
    : [];
  if (!src) throw new HttpError(404, "Release not found", { code: "release_not_found" });
  if (!(ROLLBACK_SOURCE_STATUSES as readonly string[]).includes(src.status) || !src.commit) {
    throw new HttpError(409, "Only a release that ran can be brought back", { code: "release_not_rollbackable" });
  }
  if (src.id === env.currentReleaseId) throw new HttpError(409, "This release is the one running now", { code: "release_is_current" });
  if (env.kind === "live" && env.dnsCheck?.status !== "ok") throw new HttpError(409, "The domain does not point at the server yet", { code: "live_dns_not_ok" });
  await assertServerReady(env.serverId);
  const release = await db.transaction(async (tx) => {
    await tx.select({ id: appEnvironments.id }).from(appEnvironments).where(eq(appEnvironments.id, env.id)).for("update");
    if (await activeRelease(env.id, tx)) throw new HttpError(409, "A deploy of this app is already running", { code: "app_deploy_running" });
    // a database restore of this environment waits or runs: the release waits for it
    await assertNoRestore(env.id);
    const [r] = await tx
      .insert(appReleases)
      .values({
        appId: a.id,
        workspaceId: session.workspaceId,
        environmentId: env.id,
        commit: src.commit,
        branch: src.branch,
        commitSubject: src.commitSubject,
        manifest: src.manifest,
        status: "queued",
        trigger: "rollback",
        rollbackOfId: src.id,
        promotedFromReleaseId: src.promotedFromReleaseId,
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
    details: { name: a.name, environment: env.kind, environmentId: env.id, releaseId: release.id, rollbackOfId: src.id, commit: src.commit },
  });
  await publish(session.workspaceId, { type: "release.updated", releaseId: release.id, appId: a.id, status: release.status, step: null });
  return { release: releaseDTO(release, session.name, env.kind) };
});
