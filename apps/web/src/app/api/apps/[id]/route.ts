import { and, eq } from "drizzle-orm";
import { appEnvironments, apps, audit, db } from "@wfos/db";
import { appRemoveLockKey, appUpdateSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { serverEnv } from "@/lib/server/env";
import { appDTO, appDuplicate, appReleasesShown, assertLiveRemovable, liveEnvChanges, loadApp, loadEnv, releaseOrigins, requireOwner, resolveClientProject } from "@/lib/server/apps";
import { publish, q, redis } from "@/lib/server/queue";
import { patchBody, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

/**
 * One app, its environments and the latest releases of each (no logs: GET /api/releases/[id] has them, for Members
 * and up), with the tasks behind them. Each release names its environment (environmentKind).
 */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const releases = await appReleasesShown(session.workspaceId, a.id);
  const [live] = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.appId, a.id), eq(appEnvironments.workspaceId, session.workspaceId), eq(appEnvironments.kind, "live")));
  return {
    app: await appDTO(session.workspaceId, a.id),
    releases,
    origins: await releaseOrigins(session.workspaceId, releases),
    // names only: the live env variables changed since the release live now (they apply at the next release to live)
    liveEnvChanged: await liveEnvChanges(session.workspaceId, a.id, live),
  };
});

/**
 * Rename, relink, change the default branch or the preview's access mode (the live environment's access is changed
 * with PATCH /api/apps/[id]/live). The branch applies at the next deploy, access at once on a running preview.
 */
export const PATCH = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const preview = await loadEnv(session.workspaceId, a.id, "preview");
  const input = await patchBody(req, appUpdateSchema);
  const set: Partial<typeof apps.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new HttpError(400, "A name is required", { code: "validation", fields: "name" });
    const [taken] = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.workspaceId, session.workspaceId), eq(apps.name, name)));
    if (taken && taken.id !== a.id) throw new HttpError(409, "An app with this name already exists", { code: "app_name_taken" });
    set.name = name;
  }
  if (input.branch !== undefined) set.branch = input.branch;
  if (input.clientId !== undefined || input.projectId !== undefined) {
    const link = await resolveClientProject(
      session.workspaceId,
      input.clientId !== undefined ? input.clientId : input.projectId ? null : a.clientId,
      input.projectId !== undefined ? input.projectId : input.clientId !== undefined && input.clientId !== a.clientId ? null : a.projectId,
    );
    set.clientId = link.clientId;
    set.projectId = link.projectId;
  }
  const changes: Record<string, unknown> = Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== a[k as keyof typeof a]));
  const accessChanged = input.accessMode !== undefined && input.accessMode !== preview.accessMode;
  if (accessChanged) changes.accessMode = input.accessMode;
  if (!Object.keys(changes).length) return { app: await appDTO(session.workspaceId, a.id) };
  try {
    await db.transaction(async (tx) => {
      if (Object.keys(set).length) {
        await tx
          .update(apps)
          .set({ ...set, updatedAt: new Date() })
          .where(eq(apps.id, a.id));
      }
      if (accessChanged) {
        await tx.update(appEnvironments).set({ accessMode: input.accessMode!, updatedAt: new Date() }).where(eq(appEnvironments.id, preview.id));
      }
    });
  } catch (e) {
    const dup = appDuplicate(e);
    throw dup && dup !== "port" ? dup : e;
  }
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.updated",
    targetType: "app",
    targetId: a.id,
    details: { name: set.name ?? a.name, changes },
  });
  // a running preview gets its site written again at once (password on/off); the branch applies at the next deploy
  if (accessChanged && preview.status === "running") {
    await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: preview.id, action: "republish", userId: session.userId });
  }
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: preview.status, environmentId: preview.id });
  return { app: await appDTO(session.workspaceId, a.id) };
});

/**
 * Remove the app from its servers (every environment: unit, site, files, database) and then from Workforce OS.
 * Admin, with a fresh password + 2FA confirmation; the Owner when the app has a live environment (it takes the live
 * site down too), and only with the live site stopped and its domain typed as `{ confirm }`. The worker does the removal after any deploy of this app that is still running.
 */
export const DELETE = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const envs = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.appId, a.id), eq(appEnvironments.workspaceId, session.workspaceId)));
  const liveEnv = envs.find((e) => e.kind === "live");
  if (liveEnv) {
    // the live site goes too: the Owner, with it stopped and its domain typed
    requireOwner(session);
    await assertLiveRemovable(liveEnv, req);
  }
  await requireStepUp(session);
  const locked = (await redis().set(appRemoveLockKey(a.id, serverEnv.namespace), session.userId, "PX", 10 * 60_000, "NX")) === null;
  if (locked) throw new HttpError(409, "This app is already being removed", { code: "app_removing" });
  await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, action: "remove", userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.remove_requested",
    targetType: "app",
    targetId: a.id,
    details: {
      name: a.name,
      slug: a.slug,
      environments: envs.map((e) => ({ id: e.id, kind: e.kind, domain: e.domain, serverId: e.serverId, hadDatabase: !!e.dbPasswordEnc })),
    },
  });
  return { ok: true };
});
