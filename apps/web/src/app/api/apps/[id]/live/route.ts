import { and, eq } from "drizzle-orm";
import { appEnvironments, audit, db, servers } from "@wfos/db";
import { appInstanceName, appRemoveLockKey, liveEnvironmentInputSchema, liveEnvironmentUpdateSchema, type ReleaseWindow } from "@wfos/shared";
import { checkDomains } from "@wfos/shared/dns";
import { HttpError } from "@/lib/server/auth";
import { isValidTimeZone, normaliseDays, sameReleaseWindow } from "@/lib/release-window";
import { serverEnv } from "@/lib/server/env";
import {
  activeRelease,
  appDTO,
  assertLiveDomains,
  assertLiveRemovable,
  isUuid,
  liveDuplicate,
  loadApp,
  loadEnv,
  lockDomainClaims,
  lowestFreePort,
  requireLiveOwner,
} from "@/lib/server/apps";
import { publish, q, redis } from "@/lib/server/queue";
import { body, notFound, patchBody, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

/** a live environment's memory when none is given */
const LIVE_MEMORY_MB = 512;

/**
 * Set up the app's live environment (one per app): the client's domain (+ up to 3 names that redirect to it, e.g.
 * www.) on a ready server of this workspace, its own port, instance `<slug>-live`, env, database and releases.
 * Public by default. The Owner, with a fresh step-up. Nothing runs until the first "Release to LIVE"; the DNS check
 * runs right away so the page can show the records to create.
 */
export const POST = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  await requireLiveOwner(session);
  const input = await body(req, liveEnvironmentInputSchema);
  const [exists] = await db
    .select({ id: appEnvironments.id })
    .from(appEnvironments)
    .where(and(eq(appEnvironments.appId, a.id), eq(appEnvironments.kind, "live")));
  if (exists) throw new HttpError(409, "This app already has a live environment", { code: "live_exists" });
  if (!isUuid(input.serverId)) notFound("server_not_found");
  const [server] = await db.select().from(servers).where(and(eq(servers.id, input.serverId), eq(servers.workspaceId, session.workspaceId)));
  if (!server) notFound("server_not_found");
  if (server.status !== "ready") throw new HttpError(409, "The server is not ready", { code: "server_not_ready" });
  const names = [input.domain, ...input.extraDomains];
  const instanceName = appInstanceName(a.slug, "live");

  let env: typeof appEnvironments.$inferSelect | undefined;
  // two apps claiming the same name at once: the claims are checked and written one at a time (advisory lock)
  for (let attempt = 0; !env; attempt++) {
    try {
      env = await db.transaction(async (tx) => {
        await lockDomainClaims(tx);
        await assertLiveDomains(tx, names);
        const [instanceTaken] = await tx
          .select({ id: appEnvironments.id })
          .from(appEnvironments)
          .where(and(eq(appEnvironments.serverId, server.id), eq(appEnvironments.instanceName, instanceName)));
        if (instanceTaken) throw new HttpError(409, "That server already runs an instance with this name", { code: "live_instance_taken" });
        const port = await lowestFreePort(server.id, tx);
        if (port === null) throw new HttpError(409, "No free port is left on this server", { code: "server_ports_full" });
        const [row] = await tx
          .insert(appEnvironments)
          .values({
            appId: a.id,
            workspaceId: session.workspaceId,
            kind: "live",
            serverId: server.id,
            instanceName,
            domain: input.domain,
            extraDomains: input.extraDomains,
            port,
            accessMode: "public",
            memoryMb: input.memoryMb ?? LIVE_MEMORY_MB,
            createdBy: session.userId,
          })
          .returning();
        return row!;
      });
    } catch (e) {
      const dup = liveDuplicate(e);
      if (dup === "port" && attempt < 5) continue;
      if (dup === "port") throw new HttpError(409, "No free port is left on this server", { code: "server_ports_full" });
      throw dup ?? e;
    }
  }
  const dnsCheck = await checkDomains(names, server.host);
  await db.update(appEnvironments).set({ dnsCheck }).where(eq(appEnvironments.id, env.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.live_created",
    targetType: "app",
    targetId: a.id,
    details: {
      name: a.name,
      environmentId: env.id,
      domain: env.domain,
      extraDomains: env.extraDomains,
      serverId: server.id,
      server: server.name,
      instanceName,
      port: env.port,
      memoryMb: env.memoryMb,
      dns: dnsCheck.status,
    },
  });
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: env.status, environmentId: env.id });
  return { app: await appDTO(session.workspaceId, a.id) };
});

/**
 * Change the live domain, its extra names, its access mode or its release window. The Owner. New names reset the DNS
 * check (it runs again at once) and are refused while the live environment runs or deploys: stop it first, so the
 * site never serves a name whose certificate and DNS were not checked. An access change republishes a running site.
 * The release window (`null` removes it) needs a fresh step-up too; its time zone must be one Intl knows.
 */
export const PATCH = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, a.id, "live");
  const input = await patchBody(req, liveEnvironmentUpdateSchema);
  const domain = input.domain ?? env.domain;
  const extraDomains = input.extraDomains ?? env.extraDomains ?? [];
  const before = [env.domain, ...(env.extraDomains ?? [])];
  const names = [domain, ...extraDomains];
  const namesChanged = names.length !== before.length || names.some((n, i) => n !== before[i]);
  const accessChanged = input.accessMode !== undefined && input.accessMode !== env.accessMode;
  let releaseWindow: ReleaseWindow | null | undefined;
  if (input.releaseWindow !== undefined) {
    if (input.releaseWindow && !isValidTimeZone(input.releaseWindow.timeZone)) {
      throw new HttpError(400, "Unknown time zone", { code: "release_window_time_zone", timeZone: input.releaseWindow.timeZone });
    }
    releaseWindow = input.releaseWindow && { ...input.releaseWindow, days: normaliseDays(input.releaseWindow.days) };
  }
  const windowChanged = releaseWindow !== undefined && !sameReleaseWindow(releaseWindow, env.releaseWindow ?? null);
  if (!namesChanged && !accessChanged && !windowChanged) return { app: await appDTO(session.workspaceId, a.id) };
  // when releases may reach live is a guard of the live site: confirmed with a fresh step-up like a release itself
  if (windowChanged) await requireStepUp(session);
  const set: Partial<typeof appEnvironments.$inferInsert> = { updatedAt: new Date() };
  if (namesChanged) Object.assign(set, { domain, extraDomains, dnsCheck: null });
  if (accessChanged) set.accessMode = input.accessMode;
  if (windowChanged) set.releaseWindow = releaseWindow ?? null;
  // the status seen under the environment's row lock (the same one deploy / rollback take) decides
  let status = env.status;
  try {
    await db.transaction(async (tx) => {
      if (namesChanged) await lockDomainClaims(tx);
      const [locked] = await tx.select({ status: appEnvironments.status }).from(appEnvironments).where(eq(appEnvironments.id, env.id)).for("update");
      status = locked?.status ?? env.status;
      if (namesChanged) {
        if (status === "running" || status === "deploying" || (await activeRelease(env.id, tx))) {
          throw new HttpError(409, "Stop the live environment before changing its domain", { code: "live_running_domain" });
        }
        await assertLiveDomains(tx, names, env.id);
      }
      await tx.update(appEnvironments).set(set).where(eq(appEnvironments.id, env.id));
    });
  } catch (e) {
    const dup = liveDuplicate(e);
    throw dup && dup !== "port" ? dup : e;
  }
  let dns: string | null = null;
  if (namesChanged) {
    const [server] = await db.select({ host: servers.host }).from(servers).where(eq(servers.id, env.serverId));
    if (server) {
      const dnsCheck = await checkDomains(names, server.host);
      await db.update(appEnvironments).set({ dnsCheck }).where(eq(appEnvironments.id, env.id));
      dns = dnsCheck.status;
    }
  }
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.live_updated",
    targetType: "app",
    targetId: a.id,
    details: {
      name: a.name,
      environmentId: env.id,
      ...(namesChanged && { domain: { from: env.domain, to: domain }, extraDomains: { from: env.extraDomains, to: extraDomains }, dns }),
      ...(accessChanged && { accessMode: { from: env.accessMode, to: input.accessMode } }),
      ...(windowChanged && { releaseWindow: { from: env.releaseWindow ?? null, to: releaseWindow ?? null } }),
    },
  });
  if (accessChanged && status === "running") {
    await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, action: "republish", userId: session.userId });
  }
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: env.status, environmentId: env.id });
  return { app: await appDTO(session.workspaceId, a.id) };
});

/**
 * Remove the live environment from its server (unit, site, certificate names, files, its database; the helper keeps
 * a last database dump for 30 days) and then its row with its releases. The preview stays. The Owner, with a fresh
 * step-up and the live domain typed as `{ confirm }`; refused while the live site runs (stop it first). One removal
 * of an app at a time.
 */
export const DELETE = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, a.id, "live");
  await assertLiveRemovable(env, req);
  await requireStepUp(session);
  const locked = (await redis().set(appRemoveLockKey(a.id, serverEnv.namespace), session.userId, "PX", 10 * 60_000, "NX")) === null;
  if (locked) throw new HttpError(409, "This app is already being removed", { code: "app_removing" });
  await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, action: "remove", userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.live_remove_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environmentId: env.id, domain: env.domain, extraDomains: env.extraDomains, serverId: env.serverId, hadDatabase: !!env.dbPasswordEnc },
  });
  return { ok: true };
});
