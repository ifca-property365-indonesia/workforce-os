import { audit } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadAppEnv, requireOwner } from "@/lib/server/apps";
import { q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/**
 * Stop an environment (its unit and site): `?env=preview` (default) or `?env=live`; one click on Start brings the same
 * version back. Admins stop previews; the live site is the Owner's (its visitors see an error). Never refused by the
 * kill switch (it is the safe direction).
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") requireOwner(session);
  if (env.status === "new" || env.status === "stopped") throw new HttpError(409, "The app is not running", { code: "app_not_running" });
  await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, action: "stop", userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.stop_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environment: env.kind, environmentId: env.id, status: env.status },
  });
  return { ok: true };
});
