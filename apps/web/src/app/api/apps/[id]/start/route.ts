import { audit } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { assertDeploysAllowed, loadApp } from "@/lib/server/apps";
import { q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/** Start the version that ran last again (the worker refuses when the server already runs its limit of apps). */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  await assertDeploysAllowed(session.workspaceId);
  if (!a.currentReleaseId) throw new HttpError(409, "Deploy the app first", { code: "app_never_deployed" });
  if (a.status === "running" || a.status === "deploying") throw new HttpError(409, "The app is already running", { code: "app_already_running" });
  await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, action: "start", userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.start_requested",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, status: a.status, releaseId: a.currentReleaseId },
  });
  return { ok: true };
});
