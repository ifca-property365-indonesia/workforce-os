import { audit } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { assertDeploysAllowed, assertNotRemoving, loadAppEnv, requireLiveOwner } from "@/lib/server/apps";
import { q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/**
 * Start the version that ran last again: `?env=preview` (default, Admins; the worker refuses when the server already
 * runs its limit of apps) or `?env=live` (the Owner, with a fresh step-up, once the live domain's DNS check is ok).
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") await requireLiveOwner(session);
  await assertDeploysAllowed(session.workspaceId);
  await assertNotRemoving(a.id);
  if (!env.currentReleaseId) throw new HttpError(409, "Deploy the app first", { code: "app_never_deployed" });
  if (env.status === "running" || env.status === "deploying") throw new HttpError(409, "The app is already running", { code: "app_already_running" });
  if (env.kind === "live" && env.dnsCheck?.status !== "ok") throw new HttpError(409, "The domain does not point at the server yet", { code: "live_dns_not_ok" });
  await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, action: "start", userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.start_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environment: env.kind, environmentId: env.id, status: env.status, releaseId: env.currentReleaseId },
  });
  return { ok: true };
});
