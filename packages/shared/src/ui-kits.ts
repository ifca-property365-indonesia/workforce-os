import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * C5: UI templates. The built-in kits live in packages/runner/skills/ui-kits (a built-in skill, so every sandbox has
 * them at ~/.claude/skills/ui-kits); a workspace adds its own (ui_templates, referenced as "custom:<id>"). An app uses
 * its own template, else its client's. Node only (reads the kit files).
 */

export const UI_KIT_IDS = ["korporat", "swiss", "material", "brutal", "malam", "editorial", "clay", "industri"] as const;
export type UiKitId = (typeof UI_KIT_IDS)[number];
export const UI_KIT_SCREENS = ["dashboard", "list", "form", "detail", "login"] as const;
export type UiKitScreen = (typeof UI_KIT_SCREENS)[number];
export const CUSTOM_TEMPLATE_PREFIX = "custom:";
/** a template reference stored on an app or a client: a built-in id or custom:<uuid> */
export const UI_TEMPLATE_REF = new RegExp(`^(${UI_KIT_IDS.join("|")}|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`);
export const isBuiltinKit = (ref: string): ref is UiKitId => (UI_KIT_IDS as readonly string[]).includes(ref);
export const customTemplateId = (ref: string | null | undefined) => (ref?.startsWith(CUSTOM_TEMPLATE_PREFIX) ? ref.slice(CUSTOM_TEMPLATE_PREFIX.length) : null);

export interface UiKitMeta {
  id: UiKitId;
  name: string;
  mode: "light" | "dark";
  tags: string[];
  summary: { id: string; en: string };
  fonts: Record<"display" | "body" | "mono", { family: string; package: string }>;
  googleFonts: string[];
  colors: string[];
}
export interface UiKit {
  meta: UiKitMeta;
  tokensCss: string;
  kitCss: string;
  design: string;
}

/** the kits folder: WFOS_UI_KITS_DIR, else found from the working directory (repo root, apps/web or apps/worker) */
export function uiKitsRoot(): string | null {
  const candidates = [process.env.WFOS_UI_KITS_DIR, path.resolve(process.cwd(), "packages/runner/skills/ui-kits"), path.resolve(process.cwd(), "../../packages/runner/skills/ui-kits")];
  return candidates.find((d): d is string => !!d && existsSync(path.join(d, "base.css"))) ?? null;
}

const cache = new Map<string, UiKit | null>();
export function readUiKit(id: string): UiKit | null {
  if (!isBuiltinKit(id)) return null;
  if (cache.has(id)) return cache.get(id)!;
  const root = uiKitsRoot();
  let kit: UiKit | null = null;
  // a miss is not cached: the folder may be missing only for a moment (a deploy swapping the checkout)
  if (root) {
    const dir = path.join(root, "kits", id);
    const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
    try {
      kit = { meta: JSON.parse(read("meta.json")) as UiKitMeta, tokensCss: read("tokens.css"), kitCss: read("kit.css"), design: read("DESIGN.md") };
    } catch {
      kit = null;
    }
  }
  if (kit) cache.set(id, kit);
  return kit;
}
export const listUiKits = (): UiKit[] => UI_KIT_IDS.map(readUiKit).filter((k): k is UiKit => !!k);

/** CSS from a person (a custom template) inside a <style>: it can never close the tag or pull outside resources */
export function safeCss(css: string): string {
  // CSS never needs "<" (outside strings and comments, which a token list does not need either)
  return css.replace(/</g, "").replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, "none").slice(0, 40_000);
}

/** One screen of the shared preview with a kit's (or a custom template's) tokens and personality. */
export function uiKitPreviewHtml(t: { name: string; tokensCss: string; kitCss?: string; googleFonts?: string[] }, screen: UiKitScreen, opts: { custom?: boolean } = {}): string | null {
  const root = uiKitsRoot();
  if (!root) return null;
  const tpl = readFileSync(path.join(root, "preview.html"), "utf8");
  const base = readFileSync(path.join(root, "base.css"), "utf8");
  const body = tpl.match(new RegExp(`<!--screen:${screen}-->([\\s\\S]*?)<!--/screen-->`))?.[1];
  if (!body) return null;
  const fonts = t.googleFonts?.length ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${t.googleFonts.map((f) => `family=${encodeURI(f)}`).join("&")}&display=swap">` : "";
  const css = (s: string) => (opts.custom ? safeCss(s) : s);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  // one pass over the template's own markers: a value that contains "{{…}}" is never substituted again
  const values: Record<string, string> = { NAME: esc(t.name), FONTS: fonts, BASE_CSS: base, TOKENS_CSS: css(t.tokensCss), KIT_CSS: css(t.kitCss ?? "") };
  return tpl.replace(/<body>[\s\S]*<\/body>/, () => `<body>${body}</body>`).replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);
}
