import { eq } from "drizzle-orm";
import { appDesign, apps, audit, clients, db } from "@wfos/db";
import { loadApp } from "@/lib/server/apps";
import { patchBody, route } from "@/lib/server/route";
import { assertTemplate, designSchema } from "@/lib/server/ui-templates";

/** C5: the UI template and Figma file the app follows (its own, else its client's). */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const [client] = app.clientId ? await db.select({ uiTemplate: clients.uiTemplate, figmaUrl: clients.figmaUrl }).from(clients).where(eq(clients.id, app.clientId)) : [];
  return { own: { uiTemplate: app.uiTemplate, figmaUrl: app.figmaUrl }, client: client ?? null, effective: await appDesign(session.workspaceId, app.id) };
});

/** Set the app's own template or Figma file (Admins); null follows the client again. Changes no code by itself. */
export const PUT = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await patchBody(req, designSchema);
  const app = await loadApp(session.workspaceId, params.id);
  await assertTemplate(session.workspaceId, b.uiTemplate);
  await db.update(apps).set({ ...b, updatedAt: new Date() }).where(eq(apps.id, app.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.design_set", targetType: "app", targetId: app.id, details: { name: app.name, ...b } });
  return { effective: await appDesign(session.workspaceId, app.id) };
});
