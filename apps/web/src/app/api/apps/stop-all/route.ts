import { and, eq, inArray } from "drizzle-orm";
import { appEnvironments, apps, audit, db } from "@wfos/db";
import { q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/**
 * The Owner's brake for previews: every running (or deploying) preview environment of the workspace is stopped.
 * Live environments are left alone (they serve the client's real users; each is stopped on its own app page).
 */
export const POST = route("OWNER", async ({ session }) => {
  const rows = await db
    .select({ id: apps.id, name: apps.name, environmentId: appEnvironments.id })
    .from(appEnvironments)
    .innerJoin(apps, eq(apps.id, appEnvironments.appId))
    .where(
      and(
        eq(appEnvironments.workspaceId, session.workspaceId),
        eq(apps.workspaceId, session.workspaceId),
        eq(appEnvironments.kind, "preview"),
        inArray(appEnvironments.status, ["running", "deploying"]),
      ),
    );
  for (const a of rows) {
    await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: a.environmentId, action: "stop", userId: session.userId });
  }
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.stop_all",
    targetType: "workspace",
    targetId: session.workspaceId,
    details: { count: rows.length, apps: rows.map((a) => a.name) },
  });
  return { count: rows.length };
});
