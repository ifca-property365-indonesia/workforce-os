import { eq } from "drizzle-orm";
import { appEnvironments, audit, db, workspaces } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { activeRelease, assertNotRemoving, assertServerReady, backupDTOs, loadAppEnv, requireOwner } from "@/lib/server/apps";
import { pendingDbJobs, publish, q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/**
 * The database backups of an environment (`?env=preview|live`) still on its server, newest first: taken before a
 * release (live: always; preview: before a migration), daily (live), by hand, and before a restore. Admins. They
 * live on the app server only (no offsite copy is configured).
 */
export const GET = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { env } = await loadAppEnv(session.workspaceId, params.id, req);
  return { backups: await backupDTOs(session.workspaceId, env.id) };
});

/**
 * "Back up now": a manual db_backup job for the environment's database. Admins on the preview, the Owner on live.
 * Refused without a database, while a release or a restore of that environment waits or runs, while another backup
 * is queued, and in demo mode (nothing runs on a server). The kill switch does not stop a backup (it only protects).
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") requireOwner(session);
  if (!env.dbPasswordEnc) throw new HttpError(409, "This environment has no database", { code: "app_no_database" });
  const [ws] = await db.select({ demoMode: workspaces.demoMode }).from(workspaces).where(eq(workspaces.id, session.workspaceId));
  if (ws?.demoMode) throw new HttpError(409, "Demo mode is on", { code: "apps_demo_mode" });
  await assertNotRemoving(a.id);
  await assertServerReady(env.serverId);
  await db.transaction(async (tx) => {
    // the environment row is the lock deploy, rollback and restore take too
    const [locked] = await tx.select({ status: appEnvironments.status }).from(appEnvironments).where(eq(appEnvironments.id, env.id)).for("update");
    if (locked?.status === "deploying" || (await activeRelease(env.id, tx))) {
      throw new HttpError(409, "A deploy of this app is already running", { code: "app_deploy_running" });
    }
    const pending = await pendingDbJobs(env.id);
    if (pending.includes("db_restore")) throw new HttpError(409, "A database restore of this environment is under way", { code: "app_restore_running" });
    if (pending.includes("db_backup")) throw new HttpError(409, "A backup of this environment is already queued", { code: "app_backup_running" });
    await q.deploy({ kind: "db_backup", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, userId: session.userId, backupKind: "manual" });
  });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.backup_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environment: env.kind, environmentId: env.id, domain: env.domain },
  });
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: env.status, environmentId: env.id });
  return { ok: true };
});
