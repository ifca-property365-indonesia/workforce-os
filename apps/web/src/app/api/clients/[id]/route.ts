import { and, eq } from "drizzle-orm";
import { audit, clients, db } from "@wfos/db";
import { clientInputSchema } from "@wfos/shared";
import { notFound, patchBody, route } from "@/lib/server/route";

type P = { id: string };

export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await patchBody(req, clientInputSchema.partial());
  const [c] = await db.update(clients).set(input).where(and(eq(clients.id, params.id), eq(clients.workspaceId, session.workspaceId))).returning();
  if (!c) notFound();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.updated", targetType: "client", targetId: c.id, details: input });
  return { client: c };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  await db.delete(clients).where(and(eq(clients.id, params.id), eq(clients.workspaceId, session.workspaceId)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.deleted", targetType: "client", targetId: params.id });
  return { ok: true };
});
