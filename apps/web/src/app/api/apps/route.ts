import { and, eq, or } from "drizzle-orm";
import { appEnvironments, apps, audit, db, repositories, servers } from "@wfos/db";
import { appInputSchema, appInstanceName } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { appDTO, appDTOs, appDuplicate, isUuid, lowestFreePort, resolveClientProject } from "@/lib/server/apps";
import { publish } from "@/lib/server/queue";
import { body, notFound, route } from "@/lib/server/route";

/** The workspace's apps with their preview and live environments (env names only, never values or passwords). */
export const GET = route("VIEWER", async ({ session }) => {
  return { apps: await appDTOs(session.workspaceId) };
});

/**
 * Create an app and its preview environment on a ready server of this workspace: https://<slug>.<server domain>, on
 * the lowest free port of that server. Nothing happens on the server until the first deploy.
 */
export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, appInputSchema);
  if (!isUuid(input.serverId)) notFound("server_not_found");
  const [server] = await db.select().from(servers).where(and(eq(servers.id, input.serverId), eq(servers.workspaceId, session.workspaceId)));
  if (!server) notFound("server_not_found");
  if (server.status !== "ready") throw new HttpError(409, "The server is not ready", { code: "server_not_ready" });
  const [repo] = await db
    .select({ id: repositories.id, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(and(eq(repositories.id, input.repositoryId), eq(repositories.workspaceId, session.workspaceId)));
  if (!repo) throw new HttpError(400, "Unknown repository", { code: "unknown_repository" });
  const link = await resolveClientProject(session.workspaceId, input.clientId, input.projectId);
  const name = input.name.trim();
  if (!name) throw new HttpError(400, "A name is required", { code: "validation", fields: "name" });
  const [taken] = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.workspaceId, session.workspaceId), eq(apps.name, name)));
  if (taken) throw new HttpError(409, "An app with this name already exists", { code: "app_name_taken" });
  const domain = `${input.slug}.${server.baseDomain}`;
  const instanceName = appInstanceName(input.slug, "preview");
  const [slugTaken] = await db
    .select({ id: appEnvironments.id })
    .from(appEnvironments)
    .where(or(eq(appEnvironments.domain, domain), and(eq(appEnvironments.serverId, server.id), eq(appEnvironments.instanceName, instanceName))))
    .limit(1);
  const [wsSlug] = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.workspaceId, session.workspaceId), eq(apps.slug, input.slug)));
  if (slugTaken || wsSlug) throw new HttpError(409, "This address is taken", { code: "app_slug_taken" });

  let created: { app: typeof apps.$inferSelect; env: typeof appEnvironments.$inferSelect } | undefined;
  // two apps created at once may pick the same port: the unique index decides, the loser takes the next one
  for (let attempt = 0; !created; attempt++) {
    const port = await lowestFreePort(server.id);
    if (port === null) throw new HttpError(409, "No free port is left on this server", { code: "server_ports_full" });
    try {
      created = await db.transaction(async (tx) => {
        const [app] = await tx
          .insert(apps)
          .values({
            workspaceId: session.workspaceId,
            repositoryId: repo.id,
            clientId: link.clientId,
            projectId: link.projectId,
            name,
            slug: input.slug,
            branch: input.branch ?? repo.defaultBranch,
            createdBy: session.userId,
          })
          .returning();
        const [env] = await tx
          .insert(appEnvironments)
          .values({
            appId: app!.id,
            workspaceId: session.workspaceId,
            kind: "preview",
            serverId: server.id,
            instanceName,
            domain,
            port,
            accessMode: input.accessMode,
            createdBy: session.userId,
          })
          .returning();
        return { app: app!, env: env! };
      });
    } catch (e) {
      const dup = appDuplicate(e);
      if (dup === "port" && attempt < 5) continue;
      if (dup === "port") throw new HttpError(409, "No free port is left on this server", { code: "server_ports_full" });
      throw dup ?? e;
    }
  }
  const { app: row, env } = created;
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.created",
    targetType: "app",
    targetId: row.id,
    details: {
      name: row.name,
      slug: row.slug,
      domain: env.domain,
      environmentId: env.id,
      serverId: server.id,
      server: server.name,
      repositoryId: repo.id,
      branch: row.branch,
      port: env.port,
      accessMode: env.accessMode,
    },
  });
  await publish(session.workspaceId, { type: "app.updated", appId: row.id, status: env.status, environmentId: env.id });
  return { app: await appDTO(session.workspaceId, row.id) };
});
