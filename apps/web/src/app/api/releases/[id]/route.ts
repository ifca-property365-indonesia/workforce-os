import { and, eq } from "drizzle-orm";
import { appEnvironments, appReleases, db, users } from "@wfos/db";
import { isUuid, releaseDTO } from "@/lib/server/apps";
import { notFound, route } from "@/lib/server/route";

/** One release with its log (secrets already redacted by the worker). Members and up; Viewers do not see logs. */
export const GET = route<{ id: string }>("MEMBER", async ({ session, params }) => {
  if (!isUuid(params.id)) notFound("release_not_found");
  const [row] = await db
    .select({ r: appReleases, by: users.name, kind: appEnvironments.kind })
    .from(appReleases)
    .innerJoin(appEnvironments, eq(appEnvironments.id, appReleases.environmentId))
    .leftJoin(users, eq(users.id, appReleases.createdBy))
    .where(and(eq(appReleases.id, params.id), eq(appReleases.workspaceId, session.workspaceId)));
  if (!row) notFound("release_not_found");
  return { release: releaseDTO(row.r, row.by, row.kind), log: row.r.log };
});
