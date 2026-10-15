import { and, eq } from "drizzle-orm";
import { audit, claudeLimits, db, recordUsageCalibration, workspaces } from "@wfos/db";
import { newWarning, normalizeRateLimit, sameWindow, usageStatus, usageWindows, type LimitStatus, type RawRateLimitInfo } from "@wfos/shared/limits";
import { msg } from "@wfos/shared/messages";
import { miscQueue, publish } from "./redis";
import { recordStep } from "./steps";

const TZ = process.env.APP_TIME_ZONE || "Asia/Jakarta";

function when(d: Date | null, locale: string | null): string {
  if (!d) return msg(locale, "limit.unknownTime");
  return new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

function windowName(type: string, locale: string | null): string {
  const key = `limit.${type}` as const;
  return ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"].includes(type) ? msg(locale, key as "limit.five_hour") : msg(locale, "limit.other");
}

export async function limitWindows(workspaceId: string, source?: "workspace" | "instance") {
  const rows = await db.select().from(claudeLimits).where(source ? and(eq(claudeLimits.workspaceId, workspaceId), eq(claudeLimits.credentialSource, source)) : eq(claudeLimits.workspaceId, workspaceId));
  return rows.map((r) => ({ type: r.rateLimitType, status: r.status, utilization: r.utilization, resetsAt: r.resetsAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() }));
}

/**
 * Store the latest subscription-limit value for this workspace credential, warn once at 70% and 90% per window,
 * and report whether the limit rejected the request. API-key credentials have no subscription limit: ignored.
 */
export async function recordRateLimit(
  run: { workspaceId: string; taskId: string | null; employeeId: string; credentialSource: "workspace" | "instance"; credentialType: "oauth" | "api_key" },
  info: RawRateLimitInfo,
): Promise<{ rejected: boolean; resetsAt: Date | null; window: string } | null> {
  if (run.credentialType !== "oauth") return null;
  const w = normalizeRateLimit(info);
  if (!w) return null;
  const [prev] = await db
    .select()
    .from(claudeLimits)
    .where(and(eq(claudeLimits.workspaceId, run.workspaceId), eq(claudeLimits.credentialSource, run.credentialSource), eq(claudeLimits.rateLimitType, w.type)));
  // a new window (different reset time) starts the warnings again
  const same = prev?.resetsAt && w.resetsAt ? sameWindow(prev.resetsAt, w.resetsAt) : !!prev;
  const warned = same ? (prev?.warnedThreshold ?? 0) : 0;
  const threshold = newWarning(w.utilization, warned);
  const values = { status: w.status, utilization: w.utilization, resetsAt: w.resetsAt, warnedThreshold: Math.max(warned, threshold), updatedAt: new Date() };
  await db
    .insert(claudeLimits)
    .values({ workspaceId: run.workspaceId, credentialSource: run.credentialSource, rateLimitType: w.type, ...values })
    .onConflictDoUpdate({ target: [claudeLimits.workspaceId, claudeLimits.credentialSource, claudeLimits.rateLimitType], set: values });
  // a real utilization calibrates the estimated meter (display only: never pauses or warns)
  if (w.utilization !== null) await recordUsageCalibration(run.workspaceId, run.credentialSource, w.type, w.utilization, w.resetsAt);
  await publish(run.workspaceId, { type: "limits.updated", windows: await limitWindows(run.workspaceId, run.credentialSource) });

  const locale = await localeOf(run.workspaceId);
  if (threshold && w.status !== "rejected") await warnLimit(run.workspaceId, w, threshold, locale);
  if (w.status === "rejected") {
    await pauseForQuota(run.workspaceId, w.resetsAt, w.type, locale);
    await recordStep({ workspaceId: run.workspaceId, taskId: run.taskId, employeeId: run.employeeId, kind: "budget", name: "subscription_limit", status: "blocked", output: { window: w.type, resetsAt: w.resetsAt } });
    return { rejected: true, resetsAt: w.resetsAt, window: w.type };
  }
  return { rejected: false, resetsAt: w.resetsAt, window: w.type };
}

async function localeOf(workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.locale ?? null;
}

/** The 70 % / 90 % warning of one window (sent once per window: warnedThreshold). */
async function warnLimit(workspaceId: string, w: { type: string; utilization: number | null; resetsAt: Date | null }, threshold: number, locale: string | null): Promise<void> {
  const pct = Math.round((w.utilization ?? 0) * 100);
  await publish(workspaceId, { type: "limits.warning", window: w.type, threshold, resetsAt: w.resetsAt?.toISOString() ?? null });
  await miscQueue.add("notify", {
    kind: "notify",
    notificationKind: "limits",
    workspaceId,
    subject: msg(locale, "notify.limitWarning", { pct, window: windowName(w.type, locale) }),
    text: msg(locale, "notify.limitWarningText", { pct, window: windowName(w.type, locale), resetsAt: when(w.resetsAt, locale) }),
    link: "/dashboard",
  });
}

// ---------------------------------------------------------------------------
// Real usage from Claude (the SDK's experimental usage call): rate_limit_events carry utilization (and the weekly
// window at all) only near a threshold, so without this the stored windows freeze with a past reset date.
// ---------------------------------------------------------------------------

export const USAGE_CALL_TIMEOUT_MS = 8000;
const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/**
 * Ask a live query for the plan's usage windows. Feature-detected (the method is experimental), bounded by a timeout,
 * never throws: null when the method is missing, fails or times out; [] when the credential has no plan limits.
 */
export async function fetchUsageWindows(q: unknown, timeoutMs = USAGE_CALL_TIMEOUT_MS): Promise<ReturnType<typeof usageWindows> | null> {
  try {
    const fn = (q as Record<string, unknown> | null)?.[USAGE_METHOD];
    if (typeof fn !== "function") return null;
    let timer: NodeJS.Timeout | undefined;
    const resp = await Promise.race([
      Promise.resolve((fn as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true })),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (resp === null) return null;
    return usageWindows(resp);
  } catch {
    return null;
  }
}

/**
 * Store usage windows (utilization 0..1) for a workspace credential. Same rows and warnings (70 / 90 % once per window)
 * as recordRateLimit; never pauses the queue (only a rejected request does). Returns the number of windows stored.
 */
export async function recordUsageWindows(workspaceId: string, credentialSource: "workspace" | "instance", windows: ReturnType<typeof usageWindows>): Promise<number> {
  if (!windows.length) return 0;
  const prevRows = await db.select().from(claudeLimits).where(and(eq(claudeLimits.workspaceId, workspaceId), eq(claudeLimits.credentialSource, credentialSource)));
  const locale = await localeOf(workspaceId);
  for (const w of windows) {
    const prev = prevRows.find((r) => r.rateLimitType === w.type);
    const same = !!prev && (prev.resetsAt && w.resetsAt ? sameWindow(prev.resetsAt, w.resetsAt) : !w.resetsAt);
    const status: LimitStatus = usageStatus(w.utilization, prev ? { status: prev.status, sameWindow: same } : null);
    const warned = same ? (prev?.warnedThreshold ?? 0) : 0;
    const threshold = newWarning(w.utilization, warned);
    // unknown utilization in the same window keeps the last known value
    const utilization = w.utilization ?? (same ? (prev?.utilization ?? null) : null);
    const values = { status, utilization, resetsAt: w.resetsAt, warnedThreshold: Math.max(warned, threshold), updatedAt: new Date() };
    await db
      .insert(claudeLimits)
      .values({ workspaceId, credentialSource, rateLimitType: w.type, ...values })
      .onConflictDoUpdate({ target: [claudeLimits.workspaceId, claudeLimits.credentialSource, claudeLimits.rateLimitType], set: values });
    if (threshold && status !== "rejected") await warnLimit(workspaceId, { ...w, utilization }, threshold, locale);
    // only a value reported now calibrates the estimated meter (not one carried over from an earlier report)
    if (w.utilization !== null) await recordUsageCalibration(workspaceId, credentialSource, w.type, w.utilization, w.resetsAt);
  }
  await publish(workspaceId, { type: "limits.updated", windows: await limitWindows(workspaceId, credentialSource) });
  return windows.length;
}

/** Runs read usage at most this often per workspace credential (the scheduler syncs every 15 minutes anyway). */
export const RUN_USAGE_SYNC_MIN_MS = 5 * 60_000;
const lastRunSync = new Map<string, number>();
/** Whether a run should read the usage now (and marks it read). Tests: `now` / reset with resetUsageSyncDue. */
export function usageSyncDue(key: string, now = Date.now()): boolean {
  const last = lastRunSync.get(key) ?? 0;
  if (now - last < RUN_USAGE_SYNC_MIN_MS) return false;
  lastRunSync.set(key, now);
  return true;
}
export function resetUsageSyncDue(): void {
  lastRunSync.clear();
}

/** Fetch and store the usage windows through a live query (a run's own, or the sync's). Never throws. */
export async function syncUsageFromQuery(q: unknown, workspaceId: string, credential: { source: "workspace" | "instance"; type: "oauth" | "api_key" }): Promise<"stored" | "unavailable" | "failed"> {
  if (credential.type !== "oauth") return "unavailable";
  try {
    const windows = await fetchUsageWindows(q);
    if (windows === null) return "failed";
    if (!windows.length) return "unavailable";
    await recordUsageWindows(workspaceId, credential.source, windows);
    return "stored";
  } catch {
    return "failed";
  }
}

/** Hold the workspace queue (PAUSED_QUOTA) until the limit resets; never silently continue. */
export async function pauseForQuota(workspaceId: string, until: Date | null, window: string, locale: string | null): Promise<void> {
  // unknown reset time: hold for an hour, then try again
  const resume = until ?? new Date(Date.now() + 3_600_000);
  const reason = msg(locale, "notify.limitRejectedText", { window: windowName(window, locale), resetsAt: when(until, locale) });
  const [prev] = await db.select({ until: workspaces.quotaPausedUntil }).from(workspaces).where(eq(workspaces.id, workspaceId));
  await db.update(workspaces).set({ quotaPausedUntil: resume, quotaPauseReason: reason }).where(eq(workspaces.id, workspaceId));
  await publish(workspaceId, { type: "quota.paused", until: resume.toISOString(), reason });
  if (!prev?.until || prev.until.getTime() < Date.now()) {
    await audit({ workspaceId, actorLabel: "system", action: "workspace.paused_quota", targetType: "workspace", targetId: workspaceId, details: { window, until: resume.toISOString() } });
    await miscQueue.add("notify", { kind: "notify", notificationKind: "limits", workspaceId, subject: msg(locale, "notify.limitRejected"), text: reason, link: "/dashboard" });
  }
}

/** The active quota pause of a workspace, or null (an expired pause is cleared). */
export async function activeQuotaPause(workspaceId: string): Promise<{ until: Date; reason: string } | null> {
  const [ws] = await db.select({ until: workspaces.quotaPausedUntil, reason: workspaces.quotaPauseReason }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws?.until) return null;
  if (ws.until.getTime() <= Date.now()) {
    await db.update(workspaces).set({ quotaPausedUntil: null, quotaPauseReason: null }).where(eq(workspaces.id, workspaceId));
    await publish(workspaceId, { type: "quota.resumed" });
    return null;
  }
  return { until: ws.until, reason: ws.reason ?? "" };
}
