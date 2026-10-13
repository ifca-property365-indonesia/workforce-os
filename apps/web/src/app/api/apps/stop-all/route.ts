import { and, eq, inArray } from "drizzle-orm";
import { apps, audit, db } from "@wfos/db";
import { q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/** The Owner's brake for previews: every running (or deploying) app of the workspace is stopped. */
export const POST = route("OWNER", async ({ session }) => {
  const rows = await db
    .select({ id: apps.id, name: apps.name })
    .from(apps)
    .where(and(eq(apps.workspaceId, session.workspaceId), inArray(apps.status, ["running", "deploying"])));
  for (const a of rows) await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, action: "stop", userId: session.userId });
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
