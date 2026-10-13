import { eq } from "drizzle-orm";
import { appReleases, apps, audit, db, servers } from "@wfos/db";
import { appDeploySchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { activeRelease, assertDeploysAllowed, loadApp, releaseDTO } from "@/lib/server/apps";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";

/**
 * Manual deploy by an Admin or Owner: a queued release of the given branch (its head when the worker starts) or
 * exact commit, else the app's branch. One release per app at a time. The click itself is the human decision.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const input = await body(req, appDeploySchema);
  await assertDeploysAllowed(session.workspaceId);
  if (!a.repositoryId) throw new HttpError(409, "The app's repository was removed", { code: "app_no_repository" });
  const [server] = await db.select({ status: servers.status }).from(servers).where(eq(servers.id, a.serverId));
  if (server?.status !== "ready") throw new HttpError(409, "The server is not ready", { code: "server_not_ready" });
  const release = await db.transaction(async (tx) => {
    // the app row is the lock: two clicks at once cannot both see "nothing running"
    await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, a.id)).for("update");
    if (await activeRelease(a.id, tx)) throw new HttpError(409, "A deploy of this app is already running", { code: "app_deploy_running" });
    const [r] = await tx
      .insert(appReleases)
      .values({
        appId: a.id,
        workspaceId: session.workspaceId,
        commit: input.commit ?? "",
        branch: input.branch ?? a.branch,
        status: "queued",
        trigger: "manual",
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
    action: "app.deploy_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, releaseId: release.id, branch: release.branch, commit: release.commit || null },
  });
  await publish(session.workspaceId, { type: "release.updated", releaseId: release.id, appId: a.id, status: release.status, step: null });
  return { release: releaseDTO(release, session.name) };
});
