import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit, db, tasks, workspaces } from "@wfos/db";
import { body, route } from "@/lib/server/route";
import { control, publish, q } from "@/lib/server/queue";

const schema = z.object({ engaged: z.boolean(), reason: z.string().max(500).optional() });

/** Global kill switch: stops every running employee in the workspace immediately. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const { engaged, reason } = await body(req, schema);
  await db.update(workspaces).set({ killSwitch: engaged }).where(eq(workspaces.id, session.workspaceId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: engaged ? "killswitch.engaged" : "killswitch.released", targetType: "workspace", targetId: session.workspaceId, details: { reason: reason ?? null } });
  await publish(session.workspaceId, { type: "killswitch", engaged });
  if (engaged) {
    await control({ type: "kill", workspaceId: session.workspaceId });
  } else {
    // resume queued work that was held while the switch was engaged
    const queued = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, session.workspaceId), inArray(tasks.status, ["QUEUED"])));
    for (const t of queued) await q.task(t.id, session.workspaceId);
  }
  return { ok: true };
});
