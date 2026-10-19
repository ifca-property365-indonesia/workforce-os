import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, uiTemplates } from "@wfos/db";
import { customTemplateId, isBuiltinKit, readUiKit, UI_KIT_SCREENS, uiKitPreviewHtml, type UiKitScreen } from "@wfos/shared/ui-kits";
import { notFound, route } from "@/lib/server/route";

/**
 * C5: one screen of a template's preview as a page (shown in a sandboxed iframe). Nothing on it runs: no scripts, no
 * requests but the Google Fonts of a built-in kit; a custom template's CSS is cleaned of tags, imports and urls.
 */
const CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

export const GET = route("VIEWER", async ({ session, req }) => {
  const ref = req.nextUrl.searchParams.get("ref") ?? "";
  const screen = (req.nextUrl.searchParams.get("screen") ?? "dashboard") as UiKitScreen;
  if (!UI_KIT_SCREENS.includes(screen)) notFound();
  let html: string | null = null;
  if (isBuiltinKit(ref)) {
    const kit = readUiKit(ref);
    if (kit) html = uiKitPreviewHtml({ name: kit.meta.name, tokensCss: kit.tokensCss, kitCss: kit.kitCss, googleFonts: kit.meta.googleFonts }, screen);
  } else {
    const id = customTemplateId(ref);
    const [t] = id && /^[0-9a-f-]{36}$/.test(id) ? await db.select().from(uiTemplates).where(and(eq(uiTemplates.id, id), eq(uiTemplates.workspaceId, session.workspaceId))) : [];
    if (t?.tokensCss) html = uiKitPreviewHtml({ name: t.name, tokensCss: t.tokensCss }, screen, { custom: true });
  }
  if (!html) notFound("ui_template_not_found");
  // a workspace's own template can be edited any time: its preview is never cached
  const cache = isBuiltinKit(ref) ? "private, max-age=300" : "no-store";
  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": cache, "referrer-policy": "no-referrer" },
  });
});
