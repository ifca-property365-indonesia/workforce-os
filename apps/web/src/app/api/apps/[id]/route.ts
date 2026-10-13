import { and, eq } from "drizzle-orm";
import { appReleases, apps, audit, db } from "@wfos/db";
import { appRemoveLockKey, appUpdateSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { serverEnv } from "@/lib/server/env";
import { appDTO, appDuplicate, loadApp, releaseOrigins, RELEASES_SHOWN, releasesWithNames, resolveClientProject } from "@/lib/server/apps";
import { publish, q, redis } from "@/lib/server/queue";
import { patchBody, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

/** One app and its latest releases (no logs: GET /api/releases/[id] has them, for Members and up), with the tasks behind them. */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const releases = await releasesWithNames(eq(appReleases.appId, a.id), RELEASES_SHOWN);
  return { app: await appDTO(session.workspaceId, a.id), releases, origins: await releaseOrigins(session.workspaceId, releases) };
});

/** Rename, relink, change the default branch or the access mode; branch and access apply at the next deploy or start. */
export const PATCH = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
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
  if (input.accessMode !== undefined) set.accessMode = input.accessMode;
  if (input.clientId !== undefined || input.projectId !== undefined) {
    const link = await resolveClientProject(
      session.workspaceId,
      input.clientId !== undefined ? input.clientId : input.projectId ? null : a.clientId,
      input.projectId !== undefined ? input.projectId : input.clientId !== undefined && input.clientId !== a.clientId ? null : a.projectId,
    );
    set.clientId = link.clientId;
    set.projectId = link.projectId;
  }
  const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== a[k as keyof typeof a]));
  if (!Object.keys(changes).length) return { app: await appDTO(session.workspaceId, a.id) };
  try {
    await db
      .update(apps)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(apps.id, a.id));
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
  // a running app gets its site written again at once (password on/off); the branch applies at the next deploy
  if ("accessMode" in changes && a.status === "running") {
    await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, action: "republish", userId: session.userId });
  }
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: a.status });
  return { app: await appDTO(session.workspaceId, a.id) };
});

/**
 * Remove the app from its server (unit, site, files, its database) and then from Workforce OS. Admin, with a fresh
 * password + 2FA confirmation. The worker does the removal after any deploy of this app that is still running.
 */
export const DELETE = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
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
    details: { name: a.name, slug: a.slug, domain: a.domain, serverId: a.serverId, hadDatabase: !!a.dbPasswordEnc },
  });
  return { ok: true };
});
