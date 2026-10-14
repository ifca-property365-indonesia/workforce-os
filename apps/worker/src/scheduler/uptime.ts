import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { connect as tlsConnect } from "node:tls";
import { and, desc, eq, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { appEnvironments, apps, appReleases, appUptimeChecks, audit, auditLog, db, servers, workspaces } from "@wfos/db";
import { CERT_WARN_DAYS, UPTIME_CHECK_EVERY_MS, UPTIME_RETENTION_DAYS, type UptimeStatus } from "@wfos/shared";
import { isBlockedAddress, safeFetch } from "@wfos/shared/netguard";
import { decryptSecret } from "@wfos/shared/server";
import { env as config } from "../lib/env";
import { log } from "../lib/logger";
import { redis } from "../lib/redis";
import { appUrl, envLabel, isLinkLocal, notifyOwners, publishEnvironment, type Environment } from "../deploy/common";
import { parseManifest } from "../deploy/manifest";
import { appMsg } from "../deploy/messages";

/**
 * LIVE uptime (Phase B3): every UPTIME_CHECK_EVERY_MS the platform GETs https://<domain><health> of each running LIVE
 * environment (not behind the maintenance page, not restoring), with the access login when it has one.
 *
 * False alarms are the main risk: from this VPS to its own public address the NAT hairpin drops about 1 request in
 * 200. So a CHECK is ok when any of up to 3 tries (2 s apart) answers 2xx, and the status only goes `down` after 2
 * consecutive failed checks (back `up` after 1 good one). A check whose environment changed meanwhile (a release, the
 * maintenance page, a stop) is thrown away, and a failed check long after the previous one (CONSECUTIVE_WITHIN_MS) is
 * a first failure again. Each up↔down change sets uptimeSince, publishes app.updated, is audited (app.uptime_down /
 * app.uptime_up) and notifies the Owners once (the conditional update decides who sends it) — except a flap: a down
 * less than FLAP_QUIET_MS after a recovery is not notified unless it lasts FLAP_QUIET_MS, and its recovery follows suit.
 * The uptime fetch never dials loopback, and sends the access login only to the app server's own address.
 *
 * During a good check the served certificate is read (TLS to the domain, SNI) → certExpiresAt; within CERT_WARN_DAYS
 * the Owners hear about it once a day. One row per check in app_uptime_checks, pruned after UPTIME_RETENTION_DAYS.
 * The hourly helper health check (scheduler/apps.ts) is separate and unchanged.
 */

/** how often index.ts looks for LIVE environments due a check (each is checked every UPTIME_CHECK_EVERY_MS) */
export const UPTIME_TICK_MS = 60_000;
/** a check is due a little before UPTIME_CHECK_EVERY_MS (ticks are not exact) */
const DUE_SLACK_MS = 30_000;
const BATCH = 100;
const PARALLEL = 4;
const DAY_MS = 24 * 60 * 60_000;

export const uptimeTiming = { tries: 3, retryMs: 2000, timeoutMs: 10_000 };
/** the stored check before a failed one counts toward "down" only when it is this recent (no stale streaks) */
export const CONSECUTIVE_WITHIN_MS = 2 * UPTIME_CHECK_EVERY_MS + 60_000;
/** an up/down change this soon after the previous one is not notified (flapping); a down that lasts is, late */
export const FLAP_QUIET_MS = 30 * 60_000;

// loopback (and "this host") is never checked, not even where private app servers are allowed
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addSubnet("0.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addAddress("::", "ipv6");
function isLoopback(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1];
  const v = mapped ?? bare;
  const family = isIP(v);
  return family !== 0 && loopback.check(v, family === 4 ? "ipv4" : "ipv6");
}
/** addresses an uptime check (or certificate read) never dials */
export function uptimeBlocked(ip: string): boolean {
  if (isLoopback(ip)) return true;
  return config.appServersAllowPrivate ? isLinkLocal(ip) : isBlockedAddress(ip);
}

/** DNS (tests replace it) */
export const uptimeNet = {
  lookup: async (host: string): Promise<{ address: string; family: number }[]> => lookup(host, { all: true, verbatim: true }),
};

/**
 * The address a check connects to: every address of the domain must be allowed (as safeFetch requires), one of the
 * server's addresses is preferred. `serverAddress`: it is the app server's, so the access login may be sent to it.
 */
export async function pinFor(domain: string, serverHost: string): Promise<{ address: string; family: 4 | 6; serverAddress: boolean }> {
  const records = isIP(domain) ? [{ address: domain, family: isIP(domain) }] : await uptimeNet.lookup(domain);
  if (!records.length) throw new Error(`DNS lookup returned no address for ${domain}`);
  const bad = records.find((r) => uptimeBlocked(r.address));
  if (bad) throw new Error(`${domain} resolves to ${bad.address}: blocked address`);
  const server = isIP(serverHost) ? [serverHost] : (await uptimeNet.lookup(serverHost).catch(() => [])).map((a) => a.address);
  const pick = records.find((r) => server.includes(r.address)) ?? records[0]!;
  return { address: pick.address, family: (pick.family === 6 ? 6 : 4) as 4 | 6, serverAddress: server.includes(pick.address) };
}

/**
 * GET the URL from here: the status code only (DNS resolved once by pinFor, the socket pinned to that address; no
 * redirects followed). The access login goes only to the app server's own address.
 */
async function httpStatus(url: string, headers: Record<string, string>, serverHost: string): Promise<number> {
  const pin = await pinFor(new URL(url).hostname, serverHost);
  const h = { ...headers };
  if (!pin.serverAddress) delete h.authorization;
  const r = await safeFetch(url, {
    headers: h,
    maxRedirects: 0,
    maxBytes: 4096,
    timeoutMs: uptimeTiming.timeoutMs,
    resolve: async () => [{ address: pin.address, family: pin.family }],
    isBlocked: uptimeBlocked,
  }).catch((e: Error) => {
    // a 3xx with Location is reported by safeFetch as "too many redirects": a redirect is not a healthy answer
    if (/redirect/i.test(e.message)) return { status: 302 };
    throw e;
  });
  return r.status;
}

/** The certificate the domain serves (TLS with SNI to a public address of it): its expiry, or null. Nothing is sent. */
async function certExpiry(domain: string): Promise<Date | null> {
  const address = (await uptimeNet.lookup(domain)).find((a) => !uptimeBlocked(a.address));
  if (!address) throw new Error("no public address");
  return new Promise<Date | null>((resolve, reject) => {
    // not verified on purpose: an expired or wrong certificate is exactly what this has to report
    const sock = tlsConnect({ host: address.address, port: 443, servername: domain, rejectUnauthorized: false, timeout: uptimeTiming.timeoutMs });
    sock.once("secureConnect", () => {
      const validTo = sock.getPeerCertificate()?.valid_to;
      sock.destroy();
      const at = validTo ? new Date(validTo) : null;
      resolve(at && !Number.isNaN(at.getTime()) ? at : null);
    });
    sock.once("timeout", () => {
      sock.destroy();
      reject(new Error("timeout"));
    });
    sock.once("error", (e) => {
      sock.destroy();
      reject(e);
    });
  });
}

/** Side effects tests replace (no test ever reaches a real site). */
export const uptimeDeps = {
  status: httpStatus,
  certExpiry,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  clock: () => performance.now(),
};

/** A short reason for a failed try (stored and shown): never a response body. */
export function shortError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/timeout|timed out|aborted/i.test(m)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|DNS lookup|no address/i.test(m)) return "dns";
  if (/certificate|TLS|SSL|CERT_/i.test(m)) return "tls";
  if (/ECONNREFUSED/.test(m)) return "connection refused";
  if (/ECONNRESET|socket hang up|EPIPE/i.test(m)) return "connection reset";
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return "unreachable";
  if (/not public|non-public|blocked/i.test(m)) return "blocked address";
  return m.replace(/\s+/g, " ").slice(0, 80) || "error";
}

export interface CheckResult {
  ok: boolean;
  statusCode: number | null;
  /** of the good try, or of the last failed one */
  ms: number | null;
  error: string | null;
  tries: number;
}

/** One check: up to uptimeTiming.tries GETs, retryMs apart; ok on the first 2xx. */
export async function checkUrl(url: string, headers: Record<string, string>, serverHost = ""): Promise<CheckResult> {
  let last: Omit<CheckResult, "ok" | "tries"> = { statusCode: null, ms: null, error: "no answer" };
  for (let i = 1; i <= uptimeTiming.tries; i++) {
    const t0 = uptimeDeps.clock();
    try {
      const status = await uptimeDeps.status(url, headers, serverHost);
      const ms = Math.round(uptimeDeps.clock() - t0);
      if (status >= 200 && status < 300) return { ok: true, statusCode: status, ms, error: null, tries: i };
      last = { statusCode: status, ms, error: `HTTP ${status}` };
    } catch (e) {
      last = { statusCode: null, ms: Math.round(uptimeDeps.clock() - t0), error: shortError(e) };
    }
    if (i < uptimeTiming.tries) await uptimeDeps.sleep(uptimeTiming.retryMs);
  }
  return { ok: false, ...last, tries: uptimeTiming.tries };
}

/** "12 min", "2 h 5 min" (en) / "12 menit", "2 jam 5 menit" (id) */
function durationText(ms: number, locale: string | null): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const id = locale === "id";
  if (!h) return id ? `${m} menit` : `${m} min`;
  return id ? `${h} jam${m ? ` ${m} menit` : ""}` : `${h} h${m ? ` ${m} min` : ""}`;
}

export interface UptimeTickOutcome {
  checked: { environmentId: string; ok: boolean; status: UptimeStatus; changed: boolean }[];
  /** checks thrown away because the environment changed while they ran */
  discarded: string[];
  /** live environments no longer running whose status went back to unknown */
  reset: string[];
  certWarnings: string[];
  pruned: number;
}

type DueRow = { env: Environment; appName: string; manifest: unknown; locale: string | null; serverHost: string };

/**
 * A LIVE environment that does not run (stopped, failed, removed from service) has no uptime: back to unknown (its
 * history stays). While it deploys (blue-green keeps serving) or shows the maintenance page the status is kept.
 */
async function resetNotRunning(): Promise<string[]> {
  const rows = await db
    .update(appEnvironments)
    .set({ uptimeStatus: "unknown", uptimeSince: null })
    .where(and(eq(appEnvironments.kind, "live"), ne(appEnvironments.uptimeStatus, "unknown"), notInArray(appEnvironments.status, ["running", "deploying"])))
    .returning();
  for (const e of rows) await publishEnvironment(e);
  return rows.map((e) => e.id);
}

async function dueEnvironments(now: Date): Promise<DueRow[]> {
  return db
    .select({ env: appEnvironments, appName: apps.name, manifest: appReleases.manifest, locale: workspaces.defaultLocale, serverHost: servers.host })
    .from(appEnvironments)
    .innerJoin(apps, eq(apps.id, appEnvironments.appId))
    .innerJoin(servers, eq(servers.id, appEnvironments.serverId))
    .innerJoin(workspaces, eq(workspaces.id, appEnvironments.workspaceId))
    .leftJoin(appReleases, eq(appReleases.id, appEnvironments.currentReleaseId))
    .where(
      and(
        eq(appEnvironments.kind, "live"),
        eq(appEnvironments.status, "running"),
        eq(appEnvironments.maintenance, false),
        // demo workspaces have pretend domains: never checked (no false alarm to their Owners)
        eq(workspaces.demoMode, false),
        or(isNull(appEnvironments.statusMessage), ne(appEnvironments.statusMessage, "restoring")),
        or(isNull(appEnvironments.uptimeCheckedAt), lte(appEnvironments.uptimeCheckedAt, new Date(now.getTime() - (UPTIME_CHECK_EVERY_MS - DUE_SLACK_MS)))),
      ),
    )
    .orderBy(sql`${appEnvironments.uptimeCheckedAt} asc nulls first`)
    .limit(BATCH);
}

function healthPath(manifest: unknown): string {
  try {
    return parseManifest(manifest).health;
  } catch {
    return "/";
  }
}

/** Read the served certificate after a good check; warn the Owners once a day within CERT_WARN_DAYS. */
async function certificate(e: Environment, appName: string, locale: string | null, now: Date): Promise<boolean> {
  let exp: Date | null;
  try {
    exp = await uptimeDeps.certExpiry(e.domain);
  } catch (err) {
    log.debug({ environmentId: e.id, err: (err as Error).message }, "uptime: certificate could not be read");
    return false;
  }
  if (!exp) return false;
  if (e.certExpiresAt?.getTime() !== exp.getTime()) {
    const [row] = await db.update(appEnvironments).set({ certExpiresAt: exp }).where(eq(appEnvironments.id, e.id)).returning();
    if (row) await publishEnvironment(row);
  }
  const left = exp.getTime() - now.getTime();
  if (left > CERT_WARN_DAYS * DAY_MS) return false;
  // once per (UTC) day and environment, whichever worker gets there first
  const day = now.toISOString().slice(0, 10);
  if ((await redis.set(`${config.namespace}:cert-warn:${e.id}:${day}`, "1", "PX", 2 * DAY_MS, "NX")) === null) return false;
  const name = envLabel({ name: appName }, e);
  await notifyOwners({
    workspaceId: e.workspaceId,
    appId: e.appId,
    kind: "incident",
    subject: appMsg(locale, "app.certExpiring", { name }),
    text: appMsg(locale, "app.certExpiringText", { domain: e.domain, date: exp.toISOString().slice(0, 10), days: Math.max(0, Math.ceil(left / DAY_MS)) }),
  });
  return true;
}

/** One environment: check, store, move the status, read the certificate (skipped when another worker claimed it). */
async function checkEnvironment(row: DueRow, now: Date, out: UptimeTickOutcome): Promise<void> {
  const e = row.env;
  // the check that follows this last check is done once, by whichever worker claims it
  const claim = `${config.namespace}:uptime:${e.id}:${e.uptimeCheckedAt?.getTime() ?? 0}`;
  if ((await redis.set(claim, "1", "PX", UPTIME_CHECK_EVERY_MS, "NX")) === null) return;
  const url = `${appUrl(e)}${healthPath(row.manifest)}`;
  const headers: Record<string, string> = {};
  if (e.accessMode === "password" && e.accessPasswordEnc) headers.authorization = `Basic ${Buffer.from(`preview:${decryptSecret(e.accessPasswordEnc)}`).toString("base64")}`;
  const r = await checkUrl(url, headers, row.serverHost);

  // a release, the maintenance page, a restore or a stop while it ran: the result says nothing about the site
  const [fresh] = await db.select().from(appEnvironments).where(eq(appEnvironments.id, e.id));
  if (!fresh || fresh.status !== "running" || fresh.maintenance || fresh.statusMessage === "restoring" || fresh.currentReleaseId !== e.currentReleaseId) {
    out.discarded.push(e.id);
    return;
  }
  const [stored] = await db
    .insert(appUptimeChecks)
    .values({ environmentId: e.id, workspaceId: e.workspaceId, checkedAt: now, ok: r.ok, statusCode: r.statusCode, ms: r.ms, error: r.ok ? null : r.error })
    .returning({ id: appUptimeChecks.id });
  const name = envLabel({ name: row.appName }, fresh);
  let status: UptimeStatus = fresh.uptimeStatus;
  let changed = false;

  if (r.ok) {
    if (fresh.uptimeStatus === "up") {
      await db.update(appEnvironments).set({ uptimeCheckedAt: now }).where(eq(appEnvironments.id, e.id));
    } else {
      const [moved] = await db
        .update(appEnvironments)
        .set({ uptimeStatus: "up", uptimeSince: now, uptimeCheckedAt: now })
        .where(and(eq(appEnvironments.id, e.id), eq(appEnvironments.uptimeStatus, fresh.uptimeStatus)))
        .returning();
      if (moved) {
        status = "up";
        changed = true;
        await publishEnvironment(moved);
        if (fresh.uptimeStatus === "down") {
          const downMs = now.getTime() - (fresh.uptimeSince ?? now).getTime();
          // the recovery is told only to whoever was told about the outage (a quiet flap stays quiet)
          const lastDown = await lastChange(e, "app.uptime_down");
          const notify = !lastDown || lastDown.details.notified !== false || (await redis.get(lateDownKey(e.id, lastDown.id))) !== null;
          await audit({
            workspaceId: e.workspaceId,
            actorLabel: "system",
            action: "app.uptime_up",
            targetType: "app",
            targetId: e.appId,
            details: { environmentId: e.id, url, statusCode: r.statusCode, ms: r.ms, downSince: fresh.uptimeSince?.toISOString() ?? null, downMinutes: Math.round(downMs / 60_000), at: now.toISOString(), notified: notify },
          });
          if (notify) {
            await notifyOwners({
              workspaceId: e.workspaceId,
              appId: e.appId,
              kind: "incident",
              subject: appMsg(row.locale, "app.liveUp", { name }),
              text: appMsg(row.locale, "app.liveUpText", { url: appUrl(fresh), detail: `HTTP ${r.statusCode}, ${r.ms} ms`, duration: durationText(downMs, row.locale) }),
            });
          }
        }
      }
    }
    if (await certificate(fresh, row.appName, row.locale, now)) out.certWarnings.push(e.id);
  } else {
    // the stored check before this one failed too (2 consecutive failed checks, the rule the web draws incidents
    // with), and it is recent: after a long gap a failure is a first failure again. Checks during a release, the
    // maintenance page or a restore are never stored.
    const [prev] = await db
      .select({ ok: appUptimeChecks.ok, checkedAt: appUptimeChecks.checkedAt })
      .from(appUptimeChecks)
      .where(and(eq(appUptimeChecks.environmentId, e.id), ne(appUptimeChecks.id, stored!.id), lte(appUptimeChecks.checkedAt, now)))
      .orderBy(desc(appUptimeChecks.checkedAt))
      .limit(1);
    const streak = !!prev && !prev.ok && prev.checkedAt.getTime() >= now.getTime() - CONSECUTIVE_WITHIN_MS;
    const [moved] =
      streak && fresh.uptimeStatus !== "down"
        ? await db
            .update(appEnvironments)
            // down since the first failed check of the streak
            .set({ uptimeStatus: "down", uptimeSince: prev!.checkedAt, uptimeCheckedAt: now })
            .where(and(eq(appEnvironments.id, e.id), ne(appEnvironments.uptimeStatus, "down")))
            .returning()
        : [];
    if (moved) {
      status = "down";
      changed = true;
      await publishEnvironment(moved);
      // flapping: back up less than FLAP_QUIET_MS ago → audited and published, not notified (yet)
      const lastUp = await lastChange(e, "app.uptime_up");
      const notify = !lastUp || now.getTime() - Date.parse(String(lastUp.details.at ?? 0)) >= FLAP_QUIET_MS;
      await audit({
        workspaceId: e.workspaceId,
        actorLabel: "system",
        action: "app.uptime_down",
        targetType: "app",
        targetId: e.appId,
        details: { environmentId: e.id, url, statusCode: r.statusCode, error: r.error, since: prev!.checkedAt.toISOString(), at: now.toISOString(), notified: notify },
      });
      if (notify) await notifyDown(e, row, name, fresh, r.error);
    } else {
      await db.update(appEnvironments).set({ uptimeCheckedAt: now }).where(eq(appEnvironments.id, e.id));
      // a quiet (flapping) outage that lasts FLAP_QUIET_MS is told after all, once
      if (fresh.uptimeStatus === "down") {
        const lastDown = await lastChange(e, "app.uptime_down");
        if (lastDown && lastDown.details.notified === false && now.getTime() - Date.parse(String(lastDown.details.at ?? 0)) >= FLAP_QUIET_MS) {
          if ((await redis.set(lateDownKey(e.id, lastDown.id), "1", "PX", 30 * DAY_MS, "NX")) !== null) await notifyDown(e, row, name, fresh, r.error);
        }
      }
    }
  }
  out.checked.push({ environmentId: e.id, ok: r.ok, status, changed });
}

const lateDownKey = (envId: string, auditId: string) => `${config.namespace}:uptime-late-down:${envId}:${auditId}`;

/** The environment's latest up↔down change of that kind (its audit entry). */
async function lastChange(e: Environment, action: "app.uptime_up" | "app.uptime_down") {
  const [row] = await db
    .select({ id: auditLog.id, details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, e.workspaceId), eq(auditLog.targetId, e.appId), eq(auditLog.action, action), sql`${auditLog.details}->>'environmentId' = ${e.id}`))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ? { id: row.id, details: (row.details ?? {}) as Record<string, unknown> } : null;
}

async function notifyDown(e: Environment, row: DueRow, name: string, fresh: Environment, error: string | null): Promise<void> {
  await notifyOwners({
    workspaceId: e.workspaceId,
    appId: e.appId,
    kind: "incident",
    subject: appMsg(row.locale, "app.liveDown", { name }),
    text: appMsg(row.locale, "app.liveDownText", { url: appUrl(fresh), detail: error ?? "no answer" }),
  });
}

/** rows deleted per prune statement (tests lower it) */
export const uptimeLimits = { pruneBatch: 5000 };

/** Checks older than UPTIME_RETENTION_DAYS go (at most once an hour, whichever worker claims it). */
async function prune(now: Date): Promise<number> {
  const hour = Math.floor(now.getTime() / 3_600_000);
  if ((await redis.set(`${config.namespace}:uptime-prune:${hour}`, "1", "PX", 2 * 3_600_000, "NX")) === null) return 0;
  const cutoff = new Date(now.getTime() - UPTIME_RETENTION_DAYS * DAY_MS);
  let total = 0;
  // in batches: a long-overdue prune never holds one huge delete
  for (;;) {
    const batch = db.select({ id: appUptimeChecks.id }).from(appUptimeChecks).where(lt(appUptimeChecks.checkedAt, cutoff)).limit(uptimeLimits.pruneBatch);
    const rows = await db.delete(appUptimeChecks).where(inArray(appUptimeChecks.id, batch)).returning({ id: appUptimeChecks.id });
    total += rows.length;
    if (rows.length < uptimeLimits.pruneBatch) return total;
  }
}

/** Called every UPTIME_TICK_MS by index.ts. */
export async function tickUptime(now: Date = new Date()): Promise<UptimeTickOutcome> {
  const out: UptimeTickOutcome = { checked: [], discarded: [], reset: [], certWarnings: [], pruned: 0 };
  out.reset = await resetNotRunning().catch((e: unknown) => {
    log.warn({ err: e }, "uptime: resetting stopped environments failed");
    return [] as string[];
  });
  const due = await dueEnvironments(now);
  for (let i = 0; i < due.length; i += PARALLEL) {
    await Promise.all(
      due.slice(i, i + PARALLEL).map((row) =>
        checkEnvironment(row, now, out).catch((e: unknown) => log.warn({ err: e, environmentId: row.env.id }, "uptime check failed")),
      ),
    );
  }
  out.pruned = await prune(now).catch((e: unknown) => {
    log.warn({ err: e }, "uptime: pruning old checks failed");
    return 0;
  });
  return out;
}
