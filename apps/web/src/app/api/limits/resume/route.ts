import { and, eq, like, or } from "drizzle-orm";
import { audit, db, tasks, workspaces } from "@wfos/db";
import { publish, q } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/** Resume by hand before the reset (e.g. after upgrading the plan): clear the pause and restart held tasks. */
export const POST = route("ADMIN", async ({ session }) => {
  await db.update(workspaces).set({ quotaPausedUntil: null, quotaPauseReason: null }).where(eq(workspaces.id, session.workspaceId));
  const held = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, session.workspaceId),
        eq(tasks.status, "QUEUED"),
        or(like(tasks.error, "Paused: %"), like(tasks.error, "Interrupted by the Claude subscription limit%")),
      ),
    );
  for (const t of held) await q.task(t.id, session.workspaceId);
  await publish(session.workspaceId, { type: "quota.resumed" });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "workspace.quota_resumed", targetType: "workspace", targetId: session.workspaceId, details: { tasks: held.length } });
  return { ok: true, resumed: held.length };
});
