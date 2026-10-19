import { and, eq } from "drizzle-orm";
import { audit, clients, db } from "@wfos/db";
import { isUuid } from "@/lib/server/apps";
import { notFound, patchBody, route } from "@/lib/server/route";
import { assertTemplate, designSchema } from "@/lib/server/ui-templates";

/** C5: the UI template and Figma file every app of this client follows unless the app sets its own (Admins). */
export const PUT = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await patchBody(req, designSchema);
  if (!isUuid(params.id)) notFound();
  const [c] = await db.select({ id: clients.id, name: clients.name }).from(clients).where(and(eq(clients.id, params.id), eq(clients.workspaceId, session.workspaceId)));
  if (!c) notFound();
  await assertTemplate(session.workspaceId, b.uiTemplate);
  await db.update(clients).set({ ...b, updatedAt: new Date() }).where(eq(clients.id, c.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.design_set", targetType: "client", targetId: c.id, details: { name: c.name, ...b } });
  return { ok: true };
});
