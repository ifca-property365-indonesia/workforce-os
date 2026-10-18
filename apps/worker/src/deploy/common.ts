import { randomBytes, randomInt } from "node:crypto";
import { BlockList, isIP } from "node:net";
import bcrypt from "bcryptjs";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { apps, appEnvironments, appReleases, auditLog, db, members, servers, workspaceSshPrivateKey } from "@wfos/db";
import {
  APP_ALT_PORT_OFFSET,
  APP_ENV_NAME_RE,
  APP_IDLE_STOP_DAYS,
  APP_RESERVED_ENV,
  isForbiddenAppEnv,
  type AppEnv,
  type AppManifest,
  type AppSlot,
  type AppStatus,
  type DomainCheck,
  type NotificationKind,
  type ReleaseCheckpoint,
  type ReleaseStatus,
  type ReleaseStep,
} from "@wfos/shared";
import { checkDomains } from "@wfos/shared/dns";
import { safeFetch } from "@wfos/shared/netguard";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import type { SshTarget } from "@wfos/shared/ssh";
import { env as config } from "../lib/env";
import { miscQueue, publish } from "../lib/redis";
import { helper, helperCall } from "./helper";
import type { Redactor } from "./log";

/** the app itself (name, slug, repository); where and how it runs is its environments' business */
export type App = typeof apps.$inferSelect;
/** one place an app runs (preview / live): server instance, port, domain, env, secrets, status */
export type Environment = typeof appEnvironments.$inferSelect;
export type Release = typeof appReleases.$inferSelect;
export type Server = typeof servers.$inferSelect;

/** Timings of the pipeline (tests shorten them). */
export const deployTiming = {
  logFlushMs: 2000,
  healthIntervalMs: 2000,
  healthTimeoutMs: 90_000,
  publicCheckTries: 3,
  publicCheckRetryMs: 5000,
  publicCheckTimeoutMs: 15_000,
};

/**
 * GET a preview's public URL from the worker: the status code only. DNS is resolved once and the socket pinned to
 * it (safeFetch); private addresses only where the instance allows private app servers. No redirects followed.
 */
// link-local (cloud metadata at 169.254.169.254 included): never dialled, even where private servers are allowed
const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");
export function isLinkLocal(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && linkLocal.check(ip, family === 4 ? "ipv4" : "ipv6");
}

async function publicStatus(url: string, headers: Record<string, string>): Promise<number> {
  const r = await safeFetch(url, {
    headers,
    maxRedirects: 0,
    maxBytes: 4096,
    timeoutMs: deployTiming.publicCheckTimeoutMs,
    ...(config.appServersAllowPrivate ? { isBlocked: isLinkLocal } : {}),
  }).catch((e: Error) => {
    // a 3xx with Location is reported by safeFetch as "too many redirects"
    if (/redirect/i.test(e.message)) return { status: 302 };
    throw e;
  });
  return r.status;
}

/** Side effects tests replace (the worker never reaches a real preview from a test). */
export const deployDeps = {
  publicStatus,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

export const sha8 = (sha: string) => sha.slice(0, 8);
export const appUrl = (e: Pick<Environment, "domain">) => `https://${e.domain}`;
/** the helper's database (and role) name of an instance: app_<instance with - as _> */
export const dbName = (instance: string) => `app_${instance.replace(/-/g, "_")}`;
/** how people see an environment in notifications: the app's name, "(LIVE)" for the live one */
export const envLabel = (app: Pick<App, "name">, e: Pick<Environment, "kind">) => (e.kind === "live" ? `${app.name} (LIVE)` : app.name);
export const APP_ROOT = "/srv/wfos-apps";

/** The server over SSH with the workspace's key and the pinned host key (null without a key). */
export async function sshTarget(s: Server): Promise<SshTarget | null> {
  const privateKey = await workspaceSshPrivateKey(db, s.workspaceId);
  if (!privateKey || !s.hostKey || !s.hostKeyAlgo) return null;
  return { host: s.host, port: s.port, username: s.username, privateKey, hostKeyAlgo: s.hostKeyAlgo, hostKey: s.hostKey, allowPrivate: config.appServersAllowPrivate };
}

/**
 * PREVIEWS that run (or are being deployed) on a server, `environmentId` not counted: what servers.maxRunningApps
 * limits. Live environments neither count nor are limited (a client's site never waits for a preview slot).
 */
export async function runningAppsOn(serverId: string, environmentId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.serverId, serverId),
        eq(appEnvironments.kind, "preview"),
        ne(appEnvironments.id, environmentId),
        inArray(appEnvironments.status, ["running", "deploying"]),
      ),
    );
  return r?.n ?? 0;
}

// ---- live gates (shared by releases and the start / republish actions) ----

/** Whether the user is an Owner of the workspace (LIVE actions: the web asks for step-up; this is the backstop). */
export async function isOwner(workspaceId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [m] = await db.select({ role: members.role }).from(members).where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  return m?.role === "OWNER";
}

/** Every name a live environment answers to (its domain, then the names that redirect to it). */
export const liveNames = (e: Pick<Environment, "domain" | "extraDomains">) => [e.domain, ...[...new Set(e.extraDomains ?? [])].filter((x) => x && x !== e.domain)];
const sameNames = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// ---- live blue-green slots (B2) ----

/**
 * The unit a live release runs in: one of the two slots, or "legacy" = the single unit (`wfos-app-<instance>`, the
 * `current` link, the environment's port) a live environment ran under B1 until its first slotted release moved it.
 */
export type SlotUnit = AppSlot | "legacy";

/**
 * release.checkpoint of a live release. Beyond ReleaseCheckpoint: the grace bookkeeping of the release that runs now
 * (the unit that served before it keeps running APP_LIVE_GRACE_SECONDS for an instant rollback, then is stopped).
 */
export type LiveCheckpoint = ReleaseCheckpoint & {
  /** the unit that served before this release and still runs for the grace time (null: nothing to stop) */
  graceSlot?: SlotUnit | null;
  /** the release that runs in graceSlot (an instant rollback to it only publishes its port again) */
  graceReleaseId?: string | null;
  /** ISO time the grace unit is due to be stopped */
  graceUntil?: string | null;
  /** the grace unit was stopped (or found stopped / taken over) */
  graceDone?: boolean;
  /** refused in prepare for a reason that is not the code (B3: the release window was closed): not a failed attempt */
  refusal?: "release_window";
};

export const otherSlot = (s: AppSlot): AppSlot => (s === "blue" ? "green" : "blue");
/** blue (and the B1 unit) listen on the environment's port, green on port + APP_ALT_PORT_OFFSET */
export const slotPort = (e: Pick<Environment, "port">, u: SlotUnit): number => (u === "green" ? e.port + APP_ALT_PORT_OFFSET : e.port);
/** helper flags naming the unit: `--slot <s>` for a slot; none for a preview or the B1 unit */
export const slotFlags = (u: SlotUnit | null): string[] => (u && u !== "legacy" ? ["--slot", u] : []);
/** the slot the activeSlot column records for a unit (the B1 unit listens on blue's port) */
export const slotOfUnit = (u: SlotUnit): AppSlot => (u === "legacy" ? "blue" : u);
const cpOf = (r: Pick<Release, "checkpoint"> | null | undefined) => (r?.checkpoint ?? null) as LiveCheckpoint | null;

/**
 * The unit that runs (or ran) the current release of a live environment: the slot its checkpoint names; a current
 * release without one was activated by B1 (the single unit); without a current release, the active slot.
 */
export function servingUnit(e: Pick<Environment, "activeSlot">, current: Pick<Release, "checkpoint"> | null | undefined): SlotUnit {
  if (!current) return e.activeSlot;
  return cpOf(current)?.slot ?? "legacy";
}

/**
 * Where a new live release starts: the slot that does not serve now. A first release takes the active slot (nothing
 * runs); a B1 environment's first slotted release takes green (its single unit holds blue's port).
 */
export function idleSlot(e: Pick<Environment, "activeSlot">, current: Pick<Release, "checkpoint"> | null | undefined): AppSlot {
  if (!current) return e.activeSlot;
  const u = servingUnit(e, current);
  return u === "legacy" ? "green" : otherSlot(u);
}

/** The grace unit of the current release still to be stopped, or null. */
export function pendingGrace(current: Pick<Release, "checkpoint"> | null | undefined): { slot: SlotUnit; releaseId: string | null; until: string | null } | null {
  const cp = cpOf(current);
  if (!cp?.graceSlot || cp.graceDone) return null;
  return { slot: cp.graceSlot, releaseId: cp.graceReleaseId ?? null, until: cp.graceUntil ?? null };
}

/** One unit in `slots`: its unit file is there, its state, the sha its link points at. */
export interface SlotView {
  unit: boolean;
  state: string;
  sha: string | null;
}
/** helper v4 `slots <instance>` (live only): the B1 unit, both slots, and what nginx serves. */
export interface SlotsView {
  legacy: SlotView | null;
  blue: SlotView | null;
  green: SlotView | null;
  site: { port: number | null; maintenance: boolean } | null;
}

/** What the server says about a live instance's units and site (null when it cannot tell: never throws). */
export async function readSlots(t: SshTarget, instance: string): Promise<SlotsView | null> {
  try {
    const r = await helperCall(t, "slots", [instance], { timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    const v = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as Partial<SlotsView>;
    if (!v || typeof v !== "object") return null;
    return { legacy: v.legacy ?? null, blue: v.blue ?? null, green: v.green ?? null, site: v.site ?? null };
  } catch {
    return null;
  }
}

/** Merge fields into a release's checkpoint (jsonb ||), without reading it first. */
export async function mergeCheckpoint(releaseId: string, patch: Partial<LiveCheckpoint>): Promise<void> {
  await db
    .update(appReleases)
    .set({ checkpoint: sql`coalesce(${appReleases.checkpoint}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(appReleases.id, releaseId));
}

/** Store on a release which names were just published for it (merged into its checkpoint). */
export async function recordPublishedNames(releaseId: string, names: string[]): Promise<void> {
  await mergeCheckpoint(releaseId, { publishedNames: names });
}

/**
 * Whether the environment's names still match what `current` published (its checkpoint.publishedNames): then a DNS
 * lookup ERROR (public DNS not answering) is no reason to refuse a rollback of a running live site.
 */
export function namesUnchangedSince(e: Pick<Environment, "domain" | "extraDomains">, current: Pick<Release, "checkpoint"> | null): boolean {
  const published = (current?.checkpoint as LiveCheckpoint | null | undefined)?.publishedNames;
  return Array.isArray(published) && sameNames(published, liveNames(e));
}

/** Ask public DNS whether the live names point at the server; the result is stored on the environment. */
export async function checkLiveDns(e: Environment, server: Pick<Server, "host">): Promise<DomainCheck> {
  const check = await checkDomains(liveNames(e), server.host);
  await updateEnvironment(e, { dnsCheck: check });
  e.dnsCheck = check;
  return check;
}

export const dnsLine = (check: DomainCheck) =>
  `dns: ${check.names.map((n) => `${n.name} ${n.status}${n.found.length ? ` (${n.found.join(", ")})` : ""}`).join("; ")}; expected ${check.expected.join(", ") || "?"}`;

export function dnsRefusalMessage(check: DomainCheck, serverName: string): string {
  const bad = check.names.filter((n) => n.status !== "ok").map((n) => `${n.name}: ${n.status}`);
  return `The domain does not point at server ${serverName} yet (${check.status}${bad.length ? `; ${bad.join(", ")}` : ""}): set the DNS records shown in the LIVE panel, check DNS, then try again`;
}

/** The app's environment of that kind (null when it has none). */
export async function environmentOf(appId: string, kind: Environment["kind"]): Promise<Environment | null> {
  const [row] = await db.select().from(appEnvironments).where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.kind, kind)));
  return row ?? null;
}

// ---- secrets of an environment (generated once, stored encrypted; preview and live never share one) ----

type SecretColumn = "appSecretEnc" | "dbPasswordEnc" | "accessPasswordEnc" | "testPasswordEnc";

/**
 * The decrypted secret in `column`, generated and stored first when missing. The store only happens while the column
 * is still empty, then the row is read again: the web (preview password) and the worker agree on one value.
 */
export async function ensureAppSecret(e: Environment, column: SecretColumn, generate: () => string): Promise<string> {
  if (e[column]) return decryptSecret(e[column]!);
  await db
    .update(appEnvironments)
    .set({ [column]: encryptSecret(generate()) })
    .where(and(eq(appEnvironments.id, e.id), isNull(appEnvironments[column])));
  const [row] = await db.select({ v: appEnvironments[column] }).from(appEnvironments).where(eq(appEnvironments.id, e.id));
  if (!row?.v) throw new Error("the app's secret could not be stored");
  e[column] = row.v;
  return decryptSecret(row.v);
}

const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 16 characters, no look-alikes (0/O, 1/l/I) */
export function generatePreviewPassword(): string {
  return Array.from({ length: 16 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
}
export const hexSecret = (bytes: number) => () => randomBytes(bytes).toString("hex");

/** Names the helper refuses in an env file (the sandbox sets them): never sent, and a person cannot set them. */
/** Person-set env names the platform does not allow (stored before the web refused them, or written around it). */
export function forbiddenEnvKeys(env: AppEnv): string[] {
  return Object.keys(env).filter(isForbiddenAppEnv);
}
export function forbiddenEnvMessage(keys: string[]): string {
  return `The app's environment variables ${keys.join(", ")} are set by the platform; remove them in the app's settings`;
}

/** The person-set env of an environment (decrypted); throws when it does not parse. */
const storedEnvSchema = z.record(z.string().regex(APP_ENV_NAME_RE), z.string().max(4000).refine((v) => !/[\u0000\n\r]/.test(v)));

export function extraEnv(e: Pick<Environment, "envEnc">): AppEnv {
  if (!e.envEnc) return {};
  // read leniently: a forbidden name must reach forbiddenEnvKeys (a clear refusal), not fail as unreadable
  const parsed = storedEnvSchema.safeParse(JSON.parse(decryptSecret(e.envEnc)));
  if (!parsed.success) throw new Error("the app's environment variables could not be read");
  return parsed.data;
}

/**
 * The env file of an environment for one release: its person-set variables, then the platform's own (which always
 * win): its own port, URL (its domain), APP_SECRET, data folder and database. Every value is added to the redactor
 * before anything is sent.
 */
export async function appEnvFile(e: Environment, sha: string, manifest: AppManifest, redactor: Redactor, pgPort: number | null): Promise<string> {
  const extra = extraEnv(e);
  redactor.add(...Object.values(extra));
  const forbidden = forbiddenEnvKeys(extra);
  if (forbidden.length) throw new Error(forbiddenEnvMessage(forbidden));
  const appSecret = await ensureAppSecret(e, "appSecretEnc", hexSecret(32));
  redactor.add(appSecret);
  const platform: Record<string, string> = {
    // live: both slots share this file and each listens on its own port, which its unit sets (a PORT here would win
    // over the unit's Environment=, systemd reads EnvironmentFile last)
    ...(e.kind === "live" ? {} : { PORT: String(e.port) }),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    APP_URL: appUrl(e),
    APP_SECRET: appSecret,
    APP_VERSION: sha,
    APP_DATA_DIR: `${APP_ROOT}/${e.instanceName}/data`,
  };
  // C10: the shared password of the preview's test accounts (the testUsers command reads it); never on live
  if (manifest.testUsers && e.kind !== "live") {
    platform.WFOS_TEST_PASSWORD = await ensureAppSecret(e, "testPasswordEnc", generatePreviewPassword);
    redactor.add(platform.WFOS_TEST_PASSWORD);
  }
  if (manifest.database) {
    const pw = await ensureAppSecret(e, "dbPasswordEnc", hexSecret(32));
    const name = dbName(e.instanceName);
    // the port names the socket file (/run/wfos-apps-pg/.s.PGSQL.<port>)
    if (!pgPort) throw new Error("The server reports no apps PostgreSQL cluster (postgresPort); run the new prepare.sh on it");
    platform.DATABASE_URL = `postgresql://${name}:${pw}@localhost:${pgPort}/${name}?host=/run/wfos-apps-pg`;
    redactor.add(pw, platform.DATABASE_URL);
  }
  const reserved = new Set<string>([...APP_RESERVED_ENV, ...Object.keys(platform)]);
  const lines = [...Object.entries(extra).filter(([k]) => !reserved.has(k)), ...Object.entries(platform)].map(([k, v]) => `${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Every secret the environment already has, into the redactor, before any command runs: person-set env values,
 * APP_SECRET, the database password and URL, the access password. (New ones are added as they are generated.)
 */
export function seedRedactor(e: Environment, redactor: Redactor): void {
  try {
    redactor.add(...Object.values(extraEnv(e)));
  } catch {
    // unreadable env: the step that needs it fails with its own message
  }
  for (const col of ["appSecretEnc", "dbPasswordEnc", "accessPasswordEnc", "testPasswordEnc"] as const) {
    const enc = e[col];
    if (!enc) continue;
    // the database password also covers DATABASE_URL (it contains it)
    redactor.add(decryptSecret(enc));
  }
}

// ---- server steps shared by deploys, rollbacks and start ----

/** Poll `health` (on `port`: the environment's, or a live slot's) until it answers 2xx or the time is up. */
export async function waitHealthy(t: SshTarget, e: Environment, path: string, say: (line: string) => void, port: number = e.port): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + deployTiming.healthTimeoutMs;
  let last = "no answer";
  for (let i = 0; ; i++) {
    let seen: string;
    try {
      const r = await helperCall(t, "health", [e.instanceName, port, path], { timeoutMs: 30_000 });
      const status = (() => {
        try {
          return String((JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { status?: unknown }).status ?? "?");
        } catch {
          return "?";
        }
      })();
      if (r.code === 0) {
        say(`health: ${path} answered ${status}`);
        return { ok: true, last: status };
      }
      seen = `HTTP ${status}`;
    } catch (err) {
      seen = (err as Error).message;
    }
    if (seen !== last || i === 0) say(`health: not yet (${seen})`);
    last = seen;
    if (Date.now() + deployTiming.healthIntervalMs > deadline) return { ok: false, last };
    await deployDeps.sleep(deployTiming.healthIntervalMs);
  }
}

/** The unit's state (a live slot with `flags`), for an error message or a check (never throws). */
export async function unitStatus(t: SshTarget, instance: string, flags: string[] = []): Promise<string> {
  try {
    const r = await helperCall(t, "unit-status", [instance, ...flags], { timeoutMs: 30_000 });
    return r.stdout.trim().split("\n").pop() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The access mode and password as stored now (an Admin may have changed them during the deploy). */
export async function refreshAccess(e: Environment): Promise<void> {
  const [row] = await db
    .select({ accessMode: appEnvironments.accessMode, accessPasswordEnc: appEnvironments.accessPasswordEnc })
    .from(appEnvironments)
    .where(eq(appEnvironments.id, e.id));
  if (!row) return;
  e.accessMode = row.accessMode;
  e.accessPasswordEnc = row.accessPasswordEnc;
}

/** where a publish sends the site: a port (a live slot's; default the environment's), or the maintenance page */
export interface PublishTarget {
  port?: number;
  /** serve the static maintenance page (HTTP 503) instead of proxying to the port */
  maintenance?: boolean;
}

/**
 * `publish` arguments (helper v4): `<instance> <port> [--auth] [--domain <fqdn> [--alias <fqdn>]...] [--index]
 * [--maintenance]`. A preview takes the helper's own <instance>.<baseDomain> (noindex); a live environment its domain,
 * its extra names (301 to the domain, one certificate for all) and --index (no X-Robots-Tag noindex).
 */
export function publishArgs(e: Pick<Environment, "kind" | "instanceName" | "port" | "domain" | "extraDomains">, auth: boolean, to: PublishTarget = {}): (string | number)[] {
  const args: (string | number)[] = [e.instanceName, to.port ?? e.port];
  if (auth) args.push("--auth");
  if (e.kind === "live") {
    args.push("--domain", e.domain);
    // the helper refuses a name given twice and more than 3 aliases (the web's schema allows at most 3)
    for (const alias of [...new Set(e.extraDomains ?? [])].filter((x) => x && x !== e.domain).slice(0, 3)) args.push("--alias", alias);
    args.push("--index");
  }
  if (to.maintenance) args.push("--maintenance");
  return args;
}

/** nginx site (+ certificate) of the environment, behind basic auth when its access mode (as stored now) is password. */
export async function publishSite(t: SshTarget, e: Environment, redactor: Redactor, to: PublishTarget = {}): Promise<string> {
  await refreshAccess(e);
  if (e.accessMode !== "password") {
    const r = await helper(t, "publish", publishArgs(e, false, to), { timeoutMs: 300_000 });
    return `${r.stdout}${r.stderr}`;
  }
  const pw = await ensureAppSecret(e, "accessPasswordEnc", generatePreviewPassword);
  redactor.add(pw);
  const line = `preview:${await bcrypt.hash(pw, 10)}`;
  const r = await helper(t, "publish", publishArgs(e, true, to), { stdin: `${line}\n`, timeoutMs: 300_000 });
  return `${r.stdout}${r.stderr}`;
}

/** GET https://<domain><health> from here (with the login when needed): 2xx within the tries, or throws. */
export async function publicCheck(e: Environment, path: string, say: (line: string) => void): Promise<void> {
  await refreshAccess(e);
  const url = `${appUrl(e)}${path}`;
  const headers: Record<string, string> = {};
  if (e.accessMode === "password" && e.accessPasswordEnc) headers.authorization = `Basic ${Buffer.from(`preview:${decryptSecret(e.accessPasswordEnc)}`).toString("base64")}`;
  let last = "";
  for (let i = 1; i <= deployTiming.publicCheckTries; i++) {
    try {
      const status = await deployDeps.publicStatus(url, headers);
      if (status >= 200 && status < 300) {
        say(`public check: ${url} answered ${status}`);
        return;
      }
      last = `HTTP ${status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    say(`public check ${i}/${deployTiming.publicCheckTries}: ${last}`);
    if (i < deployTiming.publicCheckTries) await deployDeps.sleep(deployTiming.publicCheckRetryMs);
  }
  throw new Error(`${url} did not answer 2xx from the internet (${last})`);
}

// ---- rows, events, notifications ----

/** Update the environment row and say so (app.updated with its environmentId). */
export async function updateEnvironment(e: Pick<Environment, "id" | "appId" | "workspaceId">, patch: Partial<typeof appEnvironments.$inferInsert>): Promise<Environment | null> {
  const [row] = await db
    .update(appEnvironments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(appEnvironments.id, e.id))
    .returning();
  if (row) await publishEnvironment(row);
  return row ?? null;
}

export async function publishEnvironment(e: Pick<Environment, "id" | "appId" | "workspaceId" | "status">): Promise<void> {
  await publish(e.workspaceId, { type: "app.updated", appId: e.appId, status: e.status, environmentId: e.id });
}

export async function updateRelease(rel: Pick<Release, "id" | "appId" | "workspaceId">, patch: Partial<typeof appReleases.$inferInsert>): Promise<Release | null> {
  const [row] = await db.update(appReleases).set(patch).where(eq(appReleases.id, rel.id)).returning();
  if (row) await publishRelease(row);
  return row ?? null;
}

export async function publishRelease(r: Pick<Release, "id" | "appId" | "workspaceId" | "status" | "step">): Promise<void> {
  await publish(r.workspaceId, { type: "release.updated", releaseId: r.id, appId: r.appId, status: r.status as ReleaseStatus, step: (r.step ?? null) as ReleaseStep | null });
}

export async function notifyApp(o: { workspaceId: string; appId: string; userId: string | null; kind: NotificationKind; subject: string; text: string }): Promise<void> {
  await miscQueue.add("notify", {
    kind: "notify",
    notificationKind: o.kind,
    workspaceId: o.workspaceId,
    // the person who started it, or every member
    ...(o.userId ? { userId: o.userId } : {}),
    subject: o.subject,
    text: o.text,
    link: `/apps/${o.appId}`,
  });
}

/** The same notification to every Owner of the workspace (LIVE needs a person: a failed undo, a failed restore). */
export async function notifyOwners(o: { workspaceId: string; appId: string; kind: NotificationKind; subject: string; text: string }): Promise<void> {
  const owners = await db.select({ userId: members.userId }).from(members).where(and(eq(members.workspaceId, o.workspaceId), eq(members.role, "OWNER")));
  for (const m of owners) await notifyApp({ ...o, userId: m.userId });
}

const IDLE_MS = APP_IDLE_STOP_DAYS * 24 * 60 * 60_000;

/**
 * Due an idle stop: a running PREVIEW (a live environment is never stopped for being idle), no new release for
 * APP_IDLE_STOP_DAYS, and not started again by a person within that time (an `app.started` audit entry of this
 * environment). Checked when the stop is queued and again when it runs.
 */
export async function idleNow(e: Pick<Environment, "id" | "appId" | "workspaceId" | "kind" | "status" | "lastDeployedAt">, now: Date = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - IDLE_MS);
  if (e.kind !== "preview" || e.status !== "running" || !e.lastDeployedAt || e.lastDeployedAt > cutoff) return false;
  const [started] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, e.workspaceId),
        eq(auditLog.action, "app.started"),
        eq(auditLog.targetId, e.appId),
        gt(auditLog.createdAt, cutoff),
        // entries from before environments (no environmentId) count for the preview
        sql`coalesce(${auditLog.details} ->> 'environmentId', ${e.id}) = ${e.id}`,
      ),
    )
    .limit(1);
  return !started;
}

/** The status an environment goes back to when a deploy ends without switching anything on. */
export function statusWithoutChange(e: Pick<Environment, "currentReleaseId">, before: AppStatus): AppStatus {
  if (!e.currentReleaseId) return "failed";
  return before === "deploying" || before === "new" ? "running" : before;
}
