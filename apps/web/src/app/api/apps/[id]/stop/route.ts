import { audit } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/** Stop the preview (its unit and site); one click on Start brings the same version back. */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  if (a.status === "new" || a.status === "stopped") throw new HttpError(409, "The app is not running", { code: "app_not_running" });
  await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, action: "stop", userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.stop_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, status: a.status },
  });
  return { ok: true };
});
