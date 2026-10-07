import { eq } from "drizzle-orm";
import { audit, db, workspaces } from "@wfos/db";
import { route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";

/** Run the scripted demo lifecycle (no tokens, no network). Turns Demo Mode on. */
export const POST = route("MEMBER", async ({ session }) => {
  await db.update(workspaces).set({ demoMode: true }).where(eq(workspaces.id, session.workspaceId));
  await q.misc({ kind: "demo", workspaceId: session.workspaceId, userId: session.userId });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "demo.started", targetType: "workspace", targetId: session.workspaceId });
  return { ok: true };
});
