import { and, eq } from "drizzle-orm";
import { appBackups, appEnvironments, audit, db } from "@wfos/db";
import { appRestoreSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { activeRelease, assertDeploysAllowed, assertNotRemoving, assertServerReady, loadAppEnv } from "@/lib/server/apps";
import { pendingDbJobs, publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

/**
 * Restore the environment's database (`?env=preview|live`) from one of its backups: the worker takes a pre_restore
 * backup first, shows the maintenance page, stops the app, restores, starts it again and checks its health. Whatever
 * was written since that backup is lost. The Owner, with a fresh step-up, typing the environment's domain as
 * `{ confirm }`. Refused while a release, a restore or a backup of that environment waits or runs, and like a
 * deploy under the kill switch and in demo mode.
 */
export const POST = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  await requireStepUp(session);
  const input = await body(req, appRestoreSchema);
  if (input.confirm.trim().toLowerCase() !== env.domain) {
    throw new HttpError(400, "Type the environment's domain to confirm", { code: "restore_confirm_mismatch" });
  }
  const [backup] = await db
    .select()
    .from(appBackups)
    .where(and(eq(appBackups.id, input.backupId), eq(appBackups.environmentId, env.id), eq(appBackups.workspaceId, session.workspaceId)));
  if (!backup) throw new HttpError(404, "Backup not found", { code: "backup_not_found" });
  if (backup.deletedAt) throw new HttpError(409, "This backup was pruned from the server", { code: "backup_pruned" });
  if (!env.dbPasswordEnc) throw new HttpError(409, "This environment has no database", { code: "app_no_database" });
  await assertDeploysAllowed(session.workspaceId);
  await assertNotRemoving(a.id);
  await assertServerReady(env.serverId);
  await db.transaction(async (tx) => {
    // the environment row is the lock deploy, rollback and backups take too: two restores never both pass
    const [locked] = await tx.select({ status: appEnvironments.status }).from(appEnvironments).where(eq(appEnvironments.id, env.id)).for("update");
    if (locked?.status === "deploying" || (await activeRelease(env.id, tx))) {
      throw new HttpError(409, "A deploy of this app is already running", { code: "app_deploy_running" });
    }
    const pending = await pendingDbJobs(env.id);
    if (pending.includes("db_restore")) throw new HttpError(409, "A database restore of this environment is under way", { code: "app_restore_running" });
    if (pending.includes("db_backup")) throw new HttpError(409, "A backup of this environment is already queued", { code: "app_backup_running" });
    await q.deploy({ kind: "db_restore", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, backupId: backup.id, userId: session.userId });
  });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.restore_requested",
    targetType: "app",
    targetId: a.id,
    details: {
      name: a.name,
      environment: env.kind,
      environmentId: env.id,
      domain: env.domain,
      backupId: backup.id,
      backup: backup.name,
      backupKind: backup.kind,
      backupCreatedAt: backup.createdAt.toISOString(),
    },
  });
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: env.status, environmentId: env.id });
  return { ok: true };
});
