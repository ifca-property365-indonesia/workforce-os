import { randomBytes, randomInt } from "node:crypto";
import { BlockList, isIP } from "node:net";
import bcrypt from "bcryptjs";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { apps, appReleases, auditLog, db, servers, workspaceSshPrivateKey } from "@wfos/db";
import { APP_ENV_NAME_RE, APP_IDLE_STOP_DAYS, APP_RESERVED_ENV, isForbiddenAppEnv, type AppEnv, type AppManifest, type AppStatus, type NotificationKind, type ReleaseStatus, type ReleaseStep } from "@wfos/shared";
import { safeFetch } from "@wfos/shared/netguard";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import type { SshTarget } from "@wfos/shared/ssh";
import { env } from "../lib/env";
import { miscQueue, publish } from "../lib/redis";
import { helper, helperCall } from "./helper";
import type { Redactor } from "./log";

export type App = typeof apps.$inferSelect;
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
    ...(env.appServersAllowPrivate ? { isBlocked: isLinkLocal } : {}),
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
export const appUrl = (a: Pick<App, "domain">) => `https://${a.domain}`;
export const dbName = (slug: string) => `app_${slug.replace(/-/g, "_")}`;
export const APP_ROOT = "/srv/wfos-apps";

/** The server over SSH with the workspace's key and the pinned host key (null without a key). */
export async function sshTarget(s: Server): Promise<SshTarget | null> {
  const privateKey = await workspaceSshPrivateKey(db, s.workspaceId);
  if (!privateKey || !s.hostKey || !s.hostKeyAlgo) return null;
  return { host: s.host, port: s.port, username: s.username, privateKey, hostKeyAlgo: s.hostKeyAlgo, hostKey: s.hostKey, allowPrivate: env.appServersAllowPrivate };
}

/** Apps that run (or are being deployed) on a server, `appId` not counted. */
export async function runningAppsOn(serverId: string, appId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apps)
    .where(and(eq(apps.serverId, serverId), ne(apps.id, appId), inArray(apps.status, ["running", "deploying"])));
  return r?.n ?? 0;
}

// ---- secrets of an app (generated once, stored encrypted) ----

type SecretColumn = "appSecretEnc" | "dbPasswordEnc" | "accessPasswordEnc";

/**
 * The decrypted secret in `column`, generated and stored first when missing. The store only happens while the column
 * is still empty, then the row is read again: the web (preview password) and the worker agree on one value.
 */
export async function ensureAppSecret(app: App, column: SecretColumn, generate: () => string): Promise<string> {
  if (app[column]) return decryptSecret(app[column]!);
  await db
    .update(apps)
    .set({ [column]: encryptSecret(generate()) })
    .where(and(eq(apps.id, app.id), isNull(apps[column])));
  const [row] = await db.select({ v: apps[column] }).from(apps).where(eq(apps.id, app.id));
  if (!row?.v) throw new Error("the app's secret could not be stored");
  app[column] = row.v;
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

/** The person-set env of an app (decrypted); throws when it does not parse. */
const storedEnvSchema = z.record(z.string().regex(APP_ENV_NAME_RE), z.string().max(4000).refine((v) => !/[\u0000\n\r]/.test(v)));

export function extraEnv(app: App): AppEnv {
  if (!app.envEnc) return {};
  // read leniently: a forbidden name must reach forbiddenEnvKeys (a clear refusal), not fail as unreadable
  const parsed = storedEnvSchema.safeParse(JSON.parse(decryptSecret(app.envEnc)));
  if (!parsed.success) throw new Error("the app's environment variables could not be read");
  return parsed.data;
}

/**
 * The env file of an app for one release: the person-set variables, then the platform's own (which always win).
 * Every value is added to the redactor before anything is sent.
 */
export async function appEnvFile(app: App, sha: string, manifest: AppManifest, redactor: Redactor, pgPort: number | null): Promise<string> {
  const extra = extraEnv(app);
  redactor.add(...Object.values(extra));
  const forbidden = forbiddenEnvKeys(extra);
  if (forbidden.length) throw new Error(forbiddenEnvMessage(forbidden));
  const appSecret = await ensureAppSecret(app, "appSecretEnc", hexSecret(32));
  redactor.add(appSecret);
  const platform: Record<string, string> = {
    PORT: String(app.port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    APP_URL: appUrl(app),
    APP_SECRET: appSecret,
    APP_VERSION: sha,
    APP_DATA_DIR: `${APP_ROOT}/${app.slug}/data`,
  };
  if (manifest.database) {
    const pw = await ensureAppSecret(app, "dbPasswordEnc", hexSecret(32));
    const name = dbName(app.slug);
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
 * Every secret the app already has, into the redactor, before any command runs: person-set env values, APP_SECRET,
 * the database password and URL, the preview password. (New ones are added as they are generated.)
 */
export function seedRedactor(app: App, redactor: Redactor): void {
  try {
    redactor.add(...Object.values(extraEnv(app)));
  } catch {
    // unreadable env: the step that needs it fails with its own message
  }
  for (const col of ["appSecretEnc", "dbPasswordEnc", "accessPasswordEnc"] as const) {
    const enc = app[col];
    if (!enc) continue;
    // the database password also covers DATABASE_URL (it contains it)
    redactor.add(decryptSecret(enc));
  }
}

// ---- server steps shared by deploys, rollbacks and start ----

/** Poll `health` until it answers 2xx or the time is up. */
export async function waitHealthy(t: SshTarget, app: App, path: string, say: (line: string) => void): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + deployTiming.healthTimeoutMs;
  let last = "no answer";
  for (let i = 0; ; i++) {
    let seen: string;
    try {
      const r = await helperCall(t, "health", [app.slug, app.port, path], { timeoutMs: 30_000 });
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
    } catch (e) {
      seen = (e as Error).message;
    }
    if (seen !== last || i === 0) say(`health: not yet (${seen})`);
    last = seen;
    if (Date.now() + deployTiming.healthIntervalMs > deadline) return { ok: false, last };
    await deployDeps.sleep(deployTiming.healthIntervalMs);
  }
}

/** The unit's state, for an error message (never throws). */
export async function unitStatus(t: SshTarget, slug: string): Promise<string> {
  try {
    const r = await helperCall(t, "unit-status", [slug], { timeoutMs: 30_000 });
    return r.stdout.trim().split("\n").pop() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The access mode and preview password as stored now (an Admin may have changed them during the deploy). */
export async function refreshAccess(app: App): Promise<void> {
  const [row] = await db.select({ accessMode: apps.accessMode, accessPasswordEnc: apps.accessPasswordEnc }).from(apps).where(eq(apps.id, app.id));
  if (!row) return;
  app.accessMode = row.accessMode;
  app.accessPasswordEnc = row.accessPasswordEnc;
}

/** nginx site (+ certificate) for the app, behind basic auth when its access mode (as stored now) is password. */
export async function publishSite(t: SshTarget, app: App, redactor: Redactor): Promise<string> {
  await refreshAccess(app);
  if (app.accessMode !== "password") {
    const r = await helper(t, "publish", [app.slug, app.port], { timeoutMs: 300_000 });
    return `${r.stdout}${r.stderr}`;
  }
  const pw = await ensureAppSecret(app, "accessPasswordEnc", generatePreviewPassword);
  redactor.add(pw);
  const line = `preview:${await bcrypt.hash(pw, 10)}`;
  const r = await helper(t, "publish", [app.slug, app.port, "--auth"], { stdin: `${line}\n`, timeoutMs: 300_000 });
  return `${r.stdout}${r.stderr}`;
}

/** GET https://<domain><health> from here (with the preview login when needed): 2xx within the tries, or throws. */
export async function publicCheck(app: App, path: string, say: (line: string) => void): Promise<void> {
  await refreshAccess(app);
  const url = `${appUrl(app)}${path}`;
  const headers: Record<string, string> = {};
  if (app.accessMode === "password" && app.accessPasswordEnc) headers.authorization = `Basic ${Buffer.from(`preview:${decryptSecret(app.accessPasswordEnc)}`).toString("base64")}`;
  let last = "";
  for (let i = 1; i <= deployTiming.publicCheckTries; i++) {
    try {
      const status = await deployDeps.publicStatus(url, headers);
      if (status >= 200 && status < 300) {
        say(`public check: ${url} answered ${status}`);
        return;
      }
      last = `HTTP ${status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    say(`public check ${i}/${deployTiming.publicCheckTries}: ${last}`);
    if (i < deployTiming.publicCheckTries) await deployDeps.sleep(deployTiming.publicCheckRetryMs);
  }
  throw new Error(`${url} did not answer 2xx from the internet (${last})`);
}

// ---- rows, events, notifications ----

export async function updateApp(app: Pick<App, "id" | "workspaceId">, patch: Partial<typeof apps.$inferInsert>): Promise<App | null> {
  const [row] = await db
    .update(apps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(apps.id, app.id))
    .returning();
  if (row) await publish(app.workspaceId, { type: "app.updated", appId: row.id, status: row.status });
  return row ?? null;
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
 * Due an idle stop: running, no new release for APP_IDLE_STOP_DAYS, and not started again by a person within that
 * time (an `app.started` audit entry). Checked when the stop is queued and again when it runs.
 */
export async function idleNow(app: Pick<App, "id" | "workspaceId" | "status" | "lastDeployedAt">, now: Date = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - IDLE_MS);
  if (app.status !== "running" || !app.lastDeployedAt || app.lastDeployedAt > cutoff) return false;
  const [started] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, app.workspaceId), eq(auditLog.action, "app.started"), eq(auditLog.targetId, app.id), gt(auditLog.createdAt, cutoff)))
    .limit(1);
  return !started;
}

/** The status an app goes back to when a deploy ends without switching anything on. */
export function statusWithoutChange(app: Pick<App, "currentReleaseId">, before: AppStatus): AppStatus {
  if (!app.currentReleaseId) return "failed";
  return before === "deploying" || before === "new" ? "running" : before;
}
