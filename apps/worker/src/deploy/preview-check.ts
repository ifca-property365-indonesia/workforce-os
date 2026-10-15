import { env as config } from "../lib/env";
import { safeFetch } from "@wfos/shared/netguard";
import { decryptSecret } from "@wfos/shared/server";
import { appUrl, isLinkLocal, refreshAccess, type Environment } from "./common";

/**
 * After a preview is deployed the platform opens its pages once, the way a visitor would (with the preview login):
 * the home page and the pages it links to. Members cannot do this from the sandbox (no app server, no database there),
 * so the head's review learns whether the deployed pages render at all. No browser: status, title and the error pages
 * of common frameworks only. Layout, forms and mobile views stay a person's check.
 */

export const PREVIEW_CHECK_MAX_PAGES = 8;
const PAGE_TIMEOUT_MS = 10_000;
const PAGE_BYTES = 400_000;

export interface PageCheck {
  path: string;
  status: number | null;
  ms: number;
  title: string | null;
  /** why this page looks broken (null: it rendered) */
  problem: string | null;
}

/** Fetches one page (tests replace it; the worker never reaches a real preview from a test). */
export const previewCheckDeps = {
  fetchPage: async (url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> => {
    const r = await safeFetch(url, { headers, maxRedirects: 3, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, ...(config.appServersAllowPrivate ? { isBlocked: isLinkLocal } : {}) });
    return { status: r.status, body: r.body };
  },
};

/** Error pages that still answer 200 or say more than their status. */
const ERROR_MARKERS: [RegExp, string][] = [
  [/Application error: a (?:server|client)-side exception has occurred/i, "Next.js application error"],
  [/id="__next_error__"/, "Next.js error page"],
  [/<title>\s*(?:500|Internal Server Error)/i, "server error page"],
  [/\bUnhandled Runtime Error\b/, "unhandled runtime error"],
];

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? decode(m[1]!).replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, 120) : null;
}

/** Same-site page links of a page (no assets, API routes or framework files), in order of appearance. */
export function pageLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*)/gi)) {
    const p = decode(m[1]!).replace(/\/+$/, "") || "/";
    if (p.startsWith("//") || /^\/(?:_next|api|static|assets)(?:\/|$)/.test(p) || /\.[a-z0-9]{2,5}$/i.test(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function pageProblem(status: number | null, body: string): string | null {
  if (status === null) return "no answer";
  if (status >= 400) return `HTTP ${status}`;
  for (const [re, label] of ERROR_MARKERS) if (re.test(body)) return label;
  return null;
}

/** Opens the home page and up to PREVIEW_CHECK_MAX_PAGES - 1 pages it links to. Never throws. */
export async function checkPreviewPages(e: Environment): Promise<PageCheck[]> {
  await refreshAccess(e).catch(() => {});
  const headers: Record<string, string> = {};
  if (e.accessMode === "password" && e.accessPasswordEnc) headers.authorization = `Basic ${Buffer.from(`preview:${decryptSecret(e.accessPasswordEnc)}`).toString("base64")}`;
  const base = appUrl(e);
  const open = async (path: string): Promise<{ check: PageCheck; body: string }> => {
    const started = Date.now();
    try {
      const r = await previewCheckDeps.fetchPage(`${base}${path}`, headers);
      return { check: { path, status: r.status, ms: Date.now() - started, title: pageTitle(r.body), problem: pageProblem(r.status, r.body) }, body: r.body };
    } catch (err) {
      return { check: { path, status: null, ms: Date.now() - started, title: null, problem: `no answer (${(err as Error).message.slice(0, 120)})` }, body: "" };
    }
  };
  const home = await open("/");
  const checks = [home.check];
  for (const p of pageLinks(home.body).filter((x) => x !== "/").slice(0, PREVIEW_CHECK_MAX_PAGES - 1)) checks.push((await open(p)).check);
  return checks;
}

/** The deliverable text for the task (and so for the head's review). */
export function previewCheckReport(url: string, checks: PageCheck[]): string {
  const bad = checks.filter((c) => c.problem);
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  return [
    bad.length
      ? `${bad.length} of ${checks.length} page(s) of the preview at ${url} look broken.`
      : `All ${checks.length} page(s) of the preview at ${url} answered and rendered without an error page.`,
    "",
    "| Page | Status | Time | Title | Problem |",
    "|---|---|---|---|---|",
    ...checks.map((c) => `| ${cell(c.path)} | ${c.status ?? "—"} | ${c.ms} ms | ${cell(c.title ?? "—")} | ${cell(c.problem ?? "—")} |`),
    "",
    "Checked by the platform without a browser: status, title and error pages. Not checked: how it looks, forms, and phone or tablet layouts. A person checks those in the preview.",
  ].join("\n");
}
