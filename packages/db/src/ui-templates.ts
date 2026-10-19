import { and, eq } from "drizzle-orm";
import { customTemplateId, isBuiltinKit, readUiKit } from "@wfos/shared/ui-kits";
import { getDb } from "./index";
import { apps, clients, uiTemplates } from "./schema";

/** C5: the UI template and Figma file an app follows: its own, else its client's. */
export interface AppDesign {
  template: {
    ref: string;
    from: "app" | "client";
    name: string;
    builtin: boolean;
    mode: "light" | "dark";
    summary: string;
    /** a custom template's design system and tokens (a built-in kit's are files in the ui-kits skill) */
    design: string | null;
    tokensCss: string | null;
  } | null;
  figma: { url: string; from: "app" | "client" } | null;
}

export async function resolveTemplate(workspaceId: string, ref: string | null): Promise<Omit<NonNullable<AppDesign["template"]>, "from"> | null> {
  if (!ref) return null;
  if (isBuiltinKit(ref)) {
    const kit = readUiKit(ref);
    return { ref, name: kit?.meta.name ?? ref, builtin: true, mode: kit?.meta.mode ?? "light", summary: kit?.meta.summary.en ?? "", design: null, tokensCss: null };
  }
  const id = customTemplateId(ref);
  if (!id) return null;
  const [t] = await getDb().select().from(uiTemplates).where(and(eq(uiTemplates.id, id), eq(uiTemplates.workspaceId, workspaceId)));
  return t ? { ref, name: t.name, builtin: false, mode: t.mode, summary: t.summary, design: t.design, tokensCss: t.tokensCss || null } : null;
}

export async function appDesign(workspaceId: string, appId: string): Promise<AppDesign> {
  const db = getDb();
  const [row] = await db
    .select({ appTemplate: apps.uiTemplate, appFigma: apps.figmaUrl, clientTemplate: clients.uiTemplate, clientFigma: clients.figmaUrl })
    .from(apps)
    .leftJoin(clients, eq(clients.id, apps.clientId))
    .where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId)));
  if (!row) return { template: null, figma: null };
  const from = row.appTemplate ? ("app" as const) : ("client" as const);
  const t = await resolveTemplate(workspaceId, row.appTemplate ?? row.clientTemplate ?? null);
  const figmaUrl = row.appFigma ?? row.clientFigma ?? null;
  return { template: t ? { ...t, from } : null, figma: figmaUrl ? { url: figmaUrl, from: row.appFigma ? "app" : "client" } : null };
}
