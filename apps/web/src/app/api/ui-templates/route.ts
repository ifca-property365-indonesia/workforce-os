import { and, desc, eq } from "drizzle-orm";
import { audit, db, uiTemplates } from "@wfos/db";
import { CUSTOM_TEMPLATE_PREFIX, listUiKits } from "@wfos/shared/ui-kits";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { templateSchema } from "@/lib/server/ui-templates";

/** C5: the built-in UI kits (meta only) and this workspace's own templates. */
export const GET = route("VIEWER", async ({ session }) => {
  const custom = await db
    .select({ id: uiTemplates.id, name: uiTemplates.name, mode: uiTemplates.mode, summary: uiTemplates.summary, tokensCss: uiTemplates.tokensCss, createdAt: uiTemplates.createdAt })
    .from(uiTemplates)
    .where(eq(uiTemplates.workspaceId, session.workspaceId))
    .orderBy(desc(uiTemplates.createdAt));
  return {
    builtin: listUiKits().map((k) => ({ ref: k.meta.id, ...k.meta })),
    custom: custom.map(({ tokensCss, ...t }) => ({ ...t, ref: `${CUSTOM_TEMPLATE_PREFIX}${t.id}`, hasPreview: tokensCss.length > 0 })),
  };
});

/** Add a workspace template (Admins): a design system the builders follow, optionally with CSS tokens for the preview. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const b = await body(req, templateSchema);
  const [taken] = await db.select({ id: uiTemplates.id }).from(uiTemplates).where(and(eq(uiTemplates.workspaceId, session.workspaceId), eq(uiTemplates.name, b.name)));
  if (taken) throw new HttpError(409, "A template with this name exists", { code: "ui_template_name_taken" });
  const [t] = await db.insert(uiTemplates).values({ workspaceId: session.workspaceId, ...b, createdBy: session.userId }).returning({ id: uiTemplates.id });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "ui_template.created", targetType: "ui_template", targetId: t!.id, details: { name: b.name } });
  return { id: t!.id, ref: `${CUSTOM_TEMPLATE_PREFIX}${t!.id}` };
});
