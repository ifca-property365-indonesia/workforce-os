import { and, eq, isNull } from "drizzle-orm";
import { audit, db, shareLinks } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

/** Revoke a view-only link (Owner): its guests lose access at their next request. */
export const DELETE = route<{ id: string }>("OWNER", async ({ session, params }) => {
  const [row] = await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, params.id), eq(shareLinks.workspaceId, session.workspaceId), isNull(shareLinks.revokedAt)))
    .returning({ id: shareLinks.id, label: shareLinks.label });
  if (!row) notFound("share_link_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "share_link.revoked", targetType: "share_link", targetId: row.id, details: { label: row.label } });
  return { ok: true };
});
