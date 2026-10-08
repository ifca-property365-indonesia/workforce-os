import { and, eq } from "drizzle-orm";
import { audit, db, repositories } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

export const DELETE = route<{ id: string }>("OWNER", async ({ session, params }) => {
  const [r] = await db.delete(repositories).where(and(eq(repositories.id, params.id), eq(repositories.workspaceId, session.workspaceId))).returning();
  if (!r) notFound("repository_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "repository.removed", targetType: "repository", targetId: r.id, details: { name: r.name } });
  return { ok: true };
});
