import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apps, clients, db, resolveTemplate } from "@wfos/db";
import { CUSTOM_TEMPLATE_PREFIX, UI_TEMPLATE_REF } from "@wfos/shared/ui-kits";
import { HttpError } from "./auth";

/** a Figma file or prototype link (the employees only read it) */
export const FIGMA_URL = /^https:\/\/(www\.)?figma\.com\/(design|file|proto|board|make)\/[A-Za-z0-9]{10,}(\/[^\s<>"`]*)?$/;

export const designSchema = z
  .object({
    uiTemplate: z.string().regex(UI_TEMPLATE_REF).nullable(),
    figmaUrl: z.string().trim().max(1000).regex(FIGMA_URL).nullable(),
  })
  .partial();

/** a template reference this workspace can use (a built-in kit, or one of its own custom templates), else 400 */
export async function assertTemplate(workspaceId: string, ref: string | null | undefined): Promise<void> {
  if (!ref) return;
  if (!(await resolveTemplate(workspaceId, ref))) throw new HttpError(400, "Unknown UI template", { code: "ui_template_not_found" });
}

/** how many apps and clients use a custom template (it cannot be removed while used) */
export async function templateUsage(workspaceId: string, id: string): Promise<number> {
  const ref = `${CUSTOM_TEMPLATE_PREFIX}${id}`;
  const a = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.workspaceId, workspaceId), eq(apps.uiTemplate, ref)));
  const c = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.workspaceId, workspaceId), eq(clients.uiTemplate, ref)));
  return a.length + c.length;
}

/** a workspace template: the design system (markdown or a prompt a person brought) and optional CSS tokens */
export const templateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  mode: z.enum(["light", "dark"]).default("light"),
  summary: z.string().trim().max(500).default(""),
  /** the design system (markdown or a prompt a person brought) */
  design: z.string().trim().min(50).max(40_000),
  tokensCss: z.string().max(20_000).default(""),
});
