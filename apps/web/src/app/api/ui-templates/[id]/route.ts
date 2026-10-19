import { and, eq, ne } from "drizzle-orm";
import { audit, db, uiTemplates } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { isUuid } from "@/lib/server/apps";
import { templateSchema, templateUsage } from "@/lib/server/ui-templates";
import { notFound, patchBody, route } from "@/lib/server/route";

async function load(workspaceId: string, id: string) {
  if (!isUuid(id)) notFound("ui_template_not_found");
  const [t] = await db.select().from(uiTemplates).where(and(eq(uiTemplates.id, id), eq(uiTemplates.workspaceId, workspaceId)));
  if (!t) notFound("ui_template_not_found");
  return t;
}

/** One workspace template with its design system and tokens. */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const t = await load(session.workspaceId, params.id);
  return { template: { ...t, usedBy: await templateUsage(session.workspaceId, t.id) } };
});

export const PATCH = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await patchBody(req, templateSchema.partial());
  const t = await load(session.workspaceId, params.id);
  if (b.name && b.name !== t.name) {
    const [taken] = await db.select({ id: uiTemplates.id }).from(uiTemplates).where(and(eq(uiTemplates.workspaceId, session.workspaceId), eq(uiTemplates.name, b.name), ne(uiTemplates.id, t.id)));
    if (taken) throw new HttpError(409, "A template with this name exists", { code: "ui_template_name_taken" });
  }
  await db.update(uiTemplates).set({ ...b, updatedAt: new Date() }).where(eq(uiTemplates.id, t.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "ui_template.updated", targetType: "ui_template", targetId: t.id, details: { name: t.name, fields: Object.keys(b) } });
  return { ok: true };
});

/** Remove a workspace template nothing uses any more (Admins). */
export const DELETE = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const t = await load(session.workspaceId, params.id);
  const used = await templateUsage(session.workspaceId, t.id);
  if (used) throw new HttpError(409, "Apps or clients still use this template", { code: "ui_template_in_use", count: used });
  await db.delete(uiTemplates).where(eq(uiTemplates.id, t.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "ui_template.removed", targetType: "ui_template", targetId: t.id, details: { name: t.name } });
  return { ok: true };
});
