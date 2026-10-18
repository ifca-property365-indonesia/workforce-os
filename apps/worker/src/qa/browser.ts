import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { totp } from "@wfos/shared/totp";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { redis } from "../lib/redis";

/**
 * C3: the browser of an app test. It runs in the platform (never in an agent sandbox), so passwords and two-factor
 * codes never reach the model: the tester asks for "sign in as approver", the platform types it.
 *
 * - Chromium runs as an unprivileged user in its own systemd scope (deploy/browser/wfos-chromium).
 * - Its resolver knows ONE name, the preview's domain, mapped to the app server (127.0.0.1 when that is this host:
 *   no NAT hairpin); every other host fails to resolve. Requests to any other origin are also aborted here.
 * - The preview's basic-auth login is sent to that origin only.
 * - One browser per test, one context per role (cookies never mix), closed when the run ends or after BROWSER_IDLE_MS.
 * - At most WFOS_BROWSER_CONCURRENCY browsers per host (Redis lease, renewed on use).
 * What the page shows is untrusted: the tools pass it through the content guard (taint).
 */

export interface TestAccount {
  role: string;
  label: string;
  username: string;
  password: string;
  totp: string | null;
  loginPath: string;
  /** this role sees every screen */
  viewAll?: boolean;
}

export interface TestTarget {
  testId: string;
  /** https://<preview domain> */
  origin: string;
  domain: string;
  /** what the domain resolves to inside the browser */
  address: string;
  basicAuth: { username: string; password: string } | null;
  accounts: TestAccount[];
}

export type ActStep =
  | { click: string }
  | { fill: Record<string, string> }
  | { select: Record<string, string> }
  | { check: string }
  | { press: string }
  | { goto: string }
  | { wait: number };

export interface PageView {
  url: string;
  title: string;
  status: number | null;
  role: string | null;
  headings: string[];
  text: string;
  fields: string[];
  buttons: string[];
  links: string[];
  alerts: string[];
  consoleErrors: string[];
  failedRequests: string[];
  screenshot: number | null;
}

/** The page operations a session needs (the real one is Playwright; tests inject a fake). */
export interface DriverPage {
  goto(url: string): Promise<number | null>;
  login(account: TestAccount, code: () => string): Promise<{ ok: boolean; detail: string }>;
  act(step: ActStep): Promise<void>;
  view(): Promise<Omit<PageView, "role" | "screenshot" | "status">>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}
export interface Driver {
  /** a fresh, isolated page (own cookies) for one role of the target */
  newPage(target: TestTarget): Promise<DriverPage>;
  close(): Promise<void>;
}
export type DriverFactory = (target: TestTarget) => Promise<Driver>;

export const BROWSER_IDLE_MS = 10 * 60_000;
const STEP_LIMIT = 15;
const TEXT_MAX = 3000;
const LIST_MAX = 30;

export class BrowserBusyError extends Error {
  constructor() {
    super("All app-test browsers on this server are busy: try again in a few minutes.");
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));

export function browserConfig() {
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/wfos-tools/ms-playwright";
  return {
    wrapper: process.env.WFOS_BROWSER_WRAPPER || path.resolve(here, "../../../../deploy/browser/wfos-chromium"),
    bin: process.env.WFOS_BROWSER_BIN || findHeadlessShell(browsers),
    runAs: process.env.WFOS_BROWSER_USER || "wfos-browser",
    memoryMb: Number(process.env.WFOS_BROWSER_MEMORY_MB) > 0 ? Number(process.env.WFOS_BROWSER_MEMORY_MB) : 1536,
    concurrency: Number(process.env.WFOS_BROWSER_CONCURRENCY) > 0 ? Number(process.env.WFOS_BROWSER_CONCURRENCY) : 2,
    /** app server addresses that are this host: mapped to 127.0.0.1 (comma list, e.g. the VPS's public IP) */
    localServerHosts: (process.env.WFOS_LOCAL_SERVER_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** the newest chrome-headless-shell a `playwright install chromium-headless-shell` put under `root` */
function findHeadlessShell(root: string): string | null {
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    const p = path.join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  return null;
}

/** what the preview's domain maps to inside the browser: loopback for an app server that is this host */
export function browserAddress(serverHost: string, localHosts: string[]): string {
  return serverHost === "127.0.0.1" || serverHost === "localhost" || localHosts.includes(serverHost) ? "127.0.0.1" : serverHost;
}

/** a request the browser may make: the preview origin, or inline data */
export function allowedRequest(origin: string, url: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return u;
  }
};

// ---------------------------------------------------------------------------
// the real driver (Playwright)
// ---------------------------------------------------------------------------

const realDriver: DriverFactory = async (target) => {
  const cfg = browserConfig();
  if (!cfg.bin) throw new Error("No browser installed for app tests: run deploy/setup-ubuntu.sh --browser on this server.");
  if (!/^[0-9a-fA-F.:]+$/.test(target.address)) throw new Error(`The app server address ${target.address} is not an IP address (the browser maps the domain to it)`);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: cfg.wrapper,
    // the user, scope and memory limit come from the wrapper; Chromium's own sandbox needs user namespaces the host may refuse
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--host-resolver-rules=MAP ${target.domain} ${target.address}, MAP * ~NOTFOUND`],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", WFOS_BROWSER_BIN: cfg.bin, WFOS_BROWSER_RUN_AS: cfg.runAs, WFOS_BROWSER_MEMORY_MB: String(cfg.memoryMb) },
    timeout: 30_000,
  });
  return {
    async newPage(t) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        acceptDownloads: false,
        ...(t.basicAuth ? { httpCredentials: { ...t.basicAuth, origin: t.origin, send: "always" as const } } : {}),
      });
      await context.route("**/*", (route) => (allowedRequest(t.origin, route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      const consoleErrors: string[] = [];
      const failed: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
      });
      page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 300)));
      page.on("requestfailed", (r) => {
        if (allowedRequest(t.origin, r.url())) failed.push(`${r.method()} ${pathOf(r.url())}: ${r.failure()?.errorText ?? "failed"}`);
      });
      page.on("response", (r) => {
        if (r.status() >= 400 && allowedRequest(t.origin, r.url())) failed.push(`${r.request().method()} ${pathOf(r.url())}: ${r.status()}`);
      });
      const settle = () => page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      const field = (label: string) => page.getByLabel(label, { exact: false }).or(page.getByPlaceholder(label, { exact: false })).first();
      return {
        async goto(url) {
          const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await settle();
          return r?.status() ?? null;
        },
        async login(account, code) {
          await page.goto(`${t.origin}${account.loginPath}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await settle();
          const user = page
            .locator("input[type=email], input[autocomplete=username], input[name*=user i], input[name*=email i], input[id*=user i], input[id*=email i], input[type=text]")
            .first();
          const pass = page.locator("input[type=password]").first();
          if (!(await pass.isVisible().catch(() => false))) return { ok: false, detail: `no password field on ${account.loginPath}` };
          await user.fill(account.username);
          await pass.fill(account.password);
          await pass.press("Enter");
          await settle();
          const otp = page.locator("input[autocomplete=one-time-code], input[name*=otp i], input[name*=totp i], input[name*=code i], input[id*=otp i], input[id*=code i]").first();
          if (await otp.isVisible().catch(() => false)) {
            if (!account.totp) return { ok: false, detail: "the app asks for a two-factor code but this test account has no TOTP key" };
            await otp.fill(code());
            await otp.press("Enter");
            await settle();
          }
          const still = await page.locator("input[type=password]").first().isVisible().catch(() => false);
          return still
            ? { ok: false, detail: "still on a page with a password field after signing in (wrong account, or the form needs something else)" }
            : { ok: true, detail: `signed in, now at ${pathOf(page.url())}` };
        },
        async act(step) {
          if ("click" in step) await page.getByRole("button", { name: step.click }).or(page.getByRole("link", { name: step.click })).or(page.getByText(step.click, { exact: false })).first().click();
          else if ("fill" in step) for (const [label, value] of Object.entries(step.fill)) await field(label).fill(value);
          else if ("select" in step) for (const [label, value] of Object.entries(step.select)) await field(label).selectOption({ label: value }).catch(() => field(label).selectOption(value));
          else if ("check" in step) await page.getByLabel(step.check, { exact: false }).first().check();
          else if ("press" in step) await page.keyboard.press(step.press);
          else if ("goto" in step) await page.goto(`${t.origin}${step.goto}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          else if ("wait" in step) await page.waitForTimeout(Math.min(5_000, Math.max(0, step.wait)));
          await settle();
        },
        async view() {
          const v = (await page.evaluate(`(${VIEW_SCRIPT})(${TEXT_MAX}, ${LIST_MAX})`)) as Omit<PageView, "role" | "screenshot" | "status" | "url" | "consoleErrors" | "failedRequests">;
          return { ...v, url: pathOf(page.url()), consoleErrors: consoleErrors.splice(0).slice(-10), failedRequests: failed.splice(0).slice(-10) };
        },
        screenshot: () => page.screenshot({ type: "png", fullPage: false }),
        close: () => context.close(),
      };
    },
    close: () => browser.close(),
  };
};

/**
 * What a page shows, read inside the page (plain JS: the worker has no DOM types). Visible elements only: headings,
 * the text, the form fields with their labels, buttons, links with their paths, alerts and live messages.
 */
const VIEW_SCRIPT = `function (max, n) {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const txt = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
  const labelOf = (el) => {
    const lab = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : el.closest("label");
    return (lab ? txt(lab) : "") || el.getAttribute("aria-label") || el.placeholder || el.name || el.type;
  };
  const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis);
  return {
    title: document.title,
    headings: all("h1,h2,h3").map(txt).filter(Boolean).slice(0, 12),
    text: ((document.body && document.body.innerText) || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, max),
    fields: all("input,select,textarea").filter((e) => e.type !== "hidden").map((e) => labelOf(e) + " (" + (e.type || e.tagName.toLowerCase()) + ")").slice(0, n),
    buttons: all("button,[role=button],input[type=submit]").map((e) => txt(e) || e.value || e.getAttribute("aria-label") || "").filter(Boolean).slice(0, n),
    links: all("a[href]").map((a) => (txt(a) || a.getAttribute("aria-label") || "?") + " → " + a.pathname).slice(0, n),
    alerts: all("[role=alert],[role=status],[aria-live]").map(txt).filter(Boolean).slice(0, 10),
  };
}`;

let driverFactory: DriverFactory = realDriver;
/** Tests: a fake browser (null = the real one). */
export function setBrowserDriver(f: DriverFactory | null): void {
  driverFactory = f ?? realDriver;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

const LEASES = () => `${env.namespace ? `${env.namespace}:` : ""}wfos:browser-sessions`;

interface Session {
  target: TestTarget;
  driver: Driver;
  pages: Map<string, DriverPage>;
  /** "" = not signed in */
  role: string;
  idle: NodeJS.Timeout | null;
  shots: number;
}
const sessions = new Map<string, Session>();

async function lease(testId: string): Promise<boolean> {
  const now = Date.now();
  const res = await redis.multi().zremrangebyscore(LEASES(), 0, now - BROWSER_IDLE_MS - 60_000).zadd(LEASES(), now, testId).zrange(LEASES(), 0, -1).exec();
  const holders = (res?.[2]?.[1] as string[] | undefined) ?? [];
  if (holders.length > browserConfig().concurrency) {
    await redis.zrem(LEASES(), testId);
    return false;
  }
  return true;
}

async function session(target: TestTarget): Promise<Session> {
  let s = sessions.get(target.testId);
  if (!s) {
    if (!(await lease(target.testId))) throw new BrowserBusyError();
    try {
      s = { target, driver: await driverFactory(target), pages: new Map(), role: "", idle: null, shots: 0 };
    } catch (e) {
      await redis.zrem(LEASES(), target.testId);
      throw e;
    }
    sessions.set(target.testId, s);
  } else {
    await redis.zadd(LEASES(), "XX", Date.now(), target.testId);
  }
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => void closeBrowserSession(target.testId), BROWSER_IDLE_MS);
  s.idle.unref();
  return s;
}

async function pageFor(s: Session, role: string): Promise<DriverPage> {
  let p = s.pages.get(role);
  if (!p) {
    p = await s.driver.newPage(s.target);
    s.pages.set(role, p);
  }
  return p;
}

export function screenshotDir(testId: string): string {
  return path.join(env.storageDir, "app-tests", testId);
}

async function viewOf(s: Session, page: DriverPage, status: number | null = null): Promise<PageView> {
  const v = await page.view();
  let screenshot: number | null = null;
  try {
    const png = await page.screenshot();
    s.shots += 1;
    const dir = screenshotDir(s.target.testId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, `${s.shots}.png`), png, { mode: 0o600 });
    screenshot = s.shots;
  } catch (e) {
    log.warn({ err: e, testId: s.target.testId }, "app test screenshot failed");
  }
  return { ...v, status, role: s.role || null, screenshot };
}

/** Open a path, signed in as `role` first when given (each role has its own page and cookies). */
export async function browserOpen(target: TestTarget, a: { path: string; role?: string | null }): Promise<{ view: PageView; login?: string }> {
  if (!a.path.startsWith("/") || a.path.startsWith("//")) throw new Error("path must start with / (a page of the app, e.g. /orders)");
  const s = await session(target);
  let login: string | undefined;
  const role = a.role ?? s.role;
  if (role && role !== s.role) {
    const account = target.accounts.find((x) => x.role === role);
    if (!account) throw new Error(`No test account for role "${role}". Roles: ${target.accounts.map((x) => x.role).join(", ") || "none"}`);
    const page = await pageFor(s, role);
    const r = await page.login(account, () => totp(account.totp!));
    if (!r.ok) throw new Error(`Could not sign in as ${role}: ${r.detail}`);
    s.role = role;
    login = r.detail;
  }
  const page = await pageFor(s, s.role);
  const status = await page.goto(`${target.origin}${a.path}`);
  return { view: await viewOf(s, page, status), login };
}

/** Do up to STEP_LIMIT steps on the open page; stops at the first that fails and says which. */
export async function browserAct(target: TestTarget, steps: ActStep[]): Promise<{ view: PageView; done: number; error: string | null }> {
  const s = sessions.get(target.testId);
  const page = s?.pages.get(s.role);
  if (!s || !page) throw new Error("No page is open: call browser_open first.");
  await session(target);
  let done = 0;
  let error: string | null = null;
  for (const step of steps.slice(0, STEP_LIMIT)) {
    try {
      await page.act(step);
      done += 1;
    } catch (e) {
      error = `step ${done + 1} (${JSON.stringify(step).slice(0, 120)}) failed: ${String((e as Error).message).split("\n")[0]!.slice(0, 300)}`;
      break;
    }
  }
  return { view: await viewOf(s, page), done, error };
}

export async function browserLook(target: TestTarget): Promise<PageView> {
  const s = sessions.get(target.testId);
  const page = s?.pages.get(s.role);
  if (!s || !page) throw new Error("No page is open: call browser_open first.");
  await session(target);
  return viewOf(s, page);
}

export async function closeBrowserSession(testId: string): Promise<void> {
  const s = sessions.get(testId);
  sessions.delete(testId);
  await redis.zrem(LEASES(), testId).catch(() => {});
  if (!s) return;
  if (s.idle) clearTimeout(s.idle);
  await s.driver.close().catch((e: unknown) => log.warn({ err: e, testId }, "closing the app-test browser failed"));
}

/** The view as text for the model (data, not instructions: the caller guards it). */
export function viewText(v: PageView, extra: string[] = []): string {
  const list = (name: string, xs: string[]) => (xs.length ? `${name}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
  return [
    ...extra,
    `Page: ${v.url}${v.status ? ` (HTTP ${v.status})` : ""} — ${v.title || "(no title)"}${v.role ? ` · signed in as ${v.role}` : " · not signed in"}`,
    list("Headings", v.headings),
    list("Alerts / messages", v.alerts),
    list("Fields", v.fields),
    list("Buttons", v.buttons),
    list("Links", v.links),
    list("Console errors", v.consoleErrors),
    list("Failed requests", v.failedRequests),
    v.screenshot ? `Screenshot: #${v.screenshot}` : "",
    `Visible text:\n${v.text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
