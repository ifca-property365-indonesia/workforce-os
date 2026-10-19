import { describe, expect, it } from "vitest";
import { isBuiltinKit, listUiKits, readUiKit, safeCss, UI_KIT_IDS, UI_KIT_SCREENS, UI_TEMPLATE_REF, uiKitPreviewHtml } from "../src/ui-kits";

const REQUIRED = ["bg", "surface", "text", "muted", "border", "border-width", "hover", "primary", "primary-text", "accent", "focus", "focus-ring", "success", "danger", "danger-text", "radius", "radius-sm", "shadow", "font-display", "font-body", "font-mono", "sidebar-bg", "sidebar-text", "nav-active-bg", "nav-active-text"];
const vars = (css: string) => Object.fromEntries([...css.matchAll(/--ui-([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

type RGB = [number, number, number];
function rgb(c: string, under: RGB = [1, 1, 1]): RGB {
  if (c.startsWith("#")) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as RGB;
  const m = c.match(/rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/)!;
  const [r, g, b, a] = m.slice(1).map(Number) as [number, number, number, number];
  return [r / 255, g / 255, b / 255].map((v, i) => a * v + (1 - a) * under[i]!) as RGB;
}
const lum = (c: RGB) => {
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (fg: RGB, bg: RGB) => (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);

describe("UI kits (C5)", () => {
  it("every built-in kit loads with its meta, tokens, personality and design rules", () => {
    expect(listUiKits().map((k) => k.meta.id)).toEqual([...UI_KIT_IDS]);
    for (const k of listUiKits()) {
      const v = vars(k.tokensCss);
      for (const name of REQUIRED) expect(v[name], `${k.meta.id} --ui-${name}`).toBeTruthy();
      expect(k.meta.fonts.body.package).toMatch(/^@fontsource(-variable)?\//);
      expect(k.design).toContain(k.meta.name);
      expect(k.kitCss.length).toBeGreaterThan(200);
    }
    expect(readUiKit("nope")).toBeNull();
  });

  it("text and controls of every kit pass WCAG AA (4.5:1), soft colors blended over the surface", () => {
    for (const k of listUiKits()) {
      const v = vars(k.tokensCss);
      const S = rgb(v["surface"]!);
      const SB = rgb(v["sidebar-bg"]!);
      const pairs: [string, string, RGB][] = [
        ["text/bg", v["text"]!, rgb(v["bg"]!)],
        ["text/surface", v["text"]!, S],
        ["muted/surface", v["muted"]!, S],
        ["muted/bg", v["muted"]!, rgb(v["bg"]!)],
        ["primary-text/primary", v["primary-text"]!, rgb(v["primary"]!)],
        ["danger-text/danger", v["danger-text"]!, rgb(v["danger"]!)],
        ["success/surface", v["success"]!, S],
        ["danger/surface", v["danger"]!, S],
        ["sidebar", v["sidebar-text"]!, SB],
        ["nav active", v["nav-active-text"]!, rgb(v["nav-active-bg"]!, SB)],
        ...(["success", "warning", "danger", "info"] as const).map((s): [string, string, RGB] => [`${s} badge`, v[`${s}-strong`]!, rgb(v[`${s}-soft`]!, S)]),
      ];
      for (const [name, fg, bg] of pairs) expect(ratio(rgb(fg, bg), bg), `${k.meta.id} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("renders every preview screen of a kit", () => {
    const k = readUiKit("swiss")!;
    for (const s of UI_KIT_SCREENS) {
      const html = uiKitPreviewHtml({ name: k.meta.name, tokensCss: k.tokensCss, kitCss: k.kitCss, googleFonts: k.meta.googleFonts }, s)!;
      expect(html).toContain("--ui-primary: #D7000F");
      expect(html).not.toContain("{{");
      expect(html).not.toContain("<!--screen:");
      expect(html).toContain("fonts.googleapis.com/css2?family=Inter+Tight");
    }
  });

  it("a custom template's CSS can neither leave its style tag nor load anything", () => {
    const evil = ':root{--ui-bg:#fff}</style><script>alert(1)</script>@import url("https://x.test/a.css"); .a{background:url(https://x.test/p.png)} .b{background:url(data:image/png;base64,AA)}';
    const out = safeCss(evil);
    expect(out).not.toMatch(/<\/style/i);
    expect(out).not.toContain("</");
    expect(out).not.toContain("@import");
    expect(out).not.toContain("x.test");
    expect(out).toContain("data:image/png");
    const html = uiKitPreviewHtml({ name: "<b>Mine</b>", tokensCss: evil }, "login", { custom: true })!;
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;b&gt;Mine&lt;/b&gt;");
    // a name holding a marker is never substituted again (one pass)
    const marked = uiKitPreviewHtml({ name: "{{TOKENS_CSS}}", tokensCss: ":root{--ui-bg:#123456}" }, "login", { custom: true })!;
    expect(marked).toContain("<title>{{TOKENS_CSS}} · pratinjau</title>");
    expect(marked).toContain(":root{--ui-bg:#123456}");
  });

  it("template references: a built-in id or custom:<uuid>", () => {
    expect(UI_TEMPLATE_REF.test("korporat")).toBe(true);
    expect(UI_TEMPLATE_REF.test("custom:0b62a227-3b03-498f-b7d8-6825411be318")).toBe(true);
    expect(UI_TEMPLATE_REF.test("custom:nope")).toBe(false);
    expect(UI_TEMPLATE_REF.test("korporat2")).toBe(false);
    expect(isBuiltinKit("malam")).toBe(true);
  });
});
