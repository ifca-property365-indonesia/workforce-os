import { randomBytes, randomInt } from "node:crypto";
import { BlockList, isIP } from "node:net";
import bcrypt from "bcryptjs";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { apps, appEnvironments, appReleases, auditLog, db, members, servers, workspaceSshPrivateKey } from "@wfos/db";
import { APP_ENV_NAME_RE, APP_IDLE_STOP_DAYS, APP_RESERVED_ENV, isForbiddenAppEnv, type AppEnv, type AppManifest, type AppStatus, type DomainCheck, type NotificationKind, type ReleaseCheckpoint, type ReleaseStatus, type ReleaseStep } from "@wfos/shared";
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

/** release.checkpoint of a live release, plus the names its publish step published (the rollback DNS exemption) */
/** kept as a name for the live gates; publishedNames is part of ReleaseCheckpoint */
export type LiveCheckpoint = ReleaseCheckpoint;

/** Store on a release which names were just published for it (merged into its checkpoint). */
export async function recordPublishedNames(releaseId: string, names: string[]): Promise<void> {
  await db
    .update(appReleases)
    .set({ checkpoint: sql`coalesce(${appReleases.checkpoint}, '{}'::jsonb) || ${JSON.stringify({ publishedNames: names })}::jsonb` })
    .where(eq(appReleases.id, releaseId));
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

type SecretColumn = "appSecretEnc" | "dbPasswordEnc" | "accessPasswordEnc";

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
    PORT: String(e.port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    APP_URL: appUrl(e),
    APP_SECRET: appSecret,
    APP_VERSION: sha,
    APP_DATA_DIR: `${APP_ROOT}/${e.instanceName}/data`,
  };
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
  for (const col of ["appSecretEnc", "dbPasswordEnc", "accessPasswordEnc"] as const) {
    const enc = e[col];
    if (!enc) continue;
    // the database password also covers DATABASE_URL (it contains it)
    redactor.add(decryptSecret(enc));
  }
}

// ---- server steps shared by deploys, rollbacks and start ----

/** Poll `health` until it answers 2xx or the time is up. */
export async function waitHealthy(t: SshTarget, e: Environment, path: string, say: (line: string) => void): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + deployTiming.healthTimeoutMs;
  let last = "no answer";
  for (let i = 0; ; i++) {
    let seen: string;
    try {
      const r = await helperCall(t, "health", [e.instanceName, e.port, path], { timeoutMs: 30_000 });
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

/** The unit's state, for an error message (never throws). */
export async function unitStatus(t: SshTarget, instance: string): Promise<string> {
  try {
    const r = await helperCall(t, "unit-status", [instance], { timeoutMs: 30_000 });
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

/**
 * `publish` arguments (helper v3): `<instance> <port> [--auth] [--domain <fqdn> [--alias <fqdn>]...] [--index]`. A
 * preview takes the helper's own <instance>.<baseDomain> (noindex); a live environment its domain, its extra names
 * (301 to the domain, one certificate for all) and --index (no X-Robots-Tag noindex).
 */
export function publishArgs(e: Pick<Environment, "kind" | "instanceName" | "port" | "domain" | "extraDomains">, auth: boolean): (string | number)[] {
  const args: (string | number)[] = [e.instanceName, e.port];
  if (auth) args.push("--auth");
  if (e.kind === "live") {
    args.push("--domain", e.domain);
    // the helper refuses a name given twice and more than 3 aliases (the web's schema allows at most 3)
    for (const alias of [...new Set(e.extraDomains ?? [])].filter((x) => x && x !== e.domain).slice(0, 3)) args.push("--alias", alias);
    args.push("--index");
  }
  return args;
}

/** nginx site (+ certificate) of the environment, behind basic auth when its access mode (as stored now) is password. */
export async function publishSite(t: SshTarget, e: Environment, redactor: Redactor): Promise<string> {
  await refreshAccess(e);
  if (e.accessMode !== "password") {
    const r = await helper(t, "publish", publishArgs(e, false), { timeoutMs: 300_000 });
    return `${r.stdout}${r.stderr}`;
  }
  const pw = await ensureAppSecret(e, "accessPasswordEnc", generatePreviewPassword);
  redactor.add(pw);
  const line = `preview:${await bcrypt.hash(pw, 10)}`;
  const r = await helper(t, "publish", publishArgs(e, true), { stdin: `${line}\n`, timeoutMs: 300_000 });
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
