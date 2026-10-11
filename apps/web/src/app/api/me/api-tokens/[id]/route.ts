import { and, eq } from "drizzle-orm";
import { apiTokens, audit, db } from "@wfos/db";
import { hasRole } from "@wfos/shared";
import { notFound, route } from "@/lib/server/route";

type P = { id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revoke a token: your own, or (OWNER/ADMIN) any token in this workspace. Revoking twice is a no-op. */
export const DELETE = route<P>("VIEWER", async ({ session, params }) => {
  if (!UUID.test(params.id)) notFound();
  const [tok] = await db.select().from(apiTokens).where(and(eq(apiTokens.id, params.id), eq(apiTokens.workspaceId, session.workspaceId)));
  if (!tok || (tok.userId !== session.userId && !hasRole(session.role, "ADMIN"))) notFound();
  if (tok.revokedAt) return { ok: true, revokedAt: tok.revokedAt };
  const revokedAt = new Date();
  await db.update(apiTokens).set({ revokedAt }).where(eq(apiTokens.id, tok.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "api_token.revoked",
    targetType: "api_token",
    targetId: tok.id,
    details: { name: tok.name, prefix: tok.prefix, ownerUserId: tok.userId },
  });
  return { ok: true, revokedAt };
});
