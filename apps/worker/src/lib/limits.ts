import { and, eq } from "drizzle-orm";
import { audit, claudeLimits, db, workspaces } from "@wfos/db";
import { newWarning, normalizeRateLimit, type RawRateLimitInfo } from "@wfos/shared/limits";
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
  return rows.map((r) => ({ type: r.rateLimitType, status: r.status, utilization: r.utilization, resetsAt: r.resetsAt?.toISOString() ?? null }));
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
  const sameWindow = prev?.resetsAt && w.resetsAt ? prev.resetsAt.getTime() === w.resetsAt.getTime() : !!prev;
  const warned = sameWindow ? (prev?.warnedThreshold ?? 0) : 0;
  const threshold = newWarning(w.utilization, warned);
  const values = { status: w.status, utilization: w.utilization, resetsAt: w.resetsAt, warnedThreshold: Math.max(warned, threshold), updatedAt: new Date() };
  await db
    .insert(claudeLimits)
    .values({ workspaceId: run.workspaceId, credentialSource: run.credentialSource, rateLimitType: w.type, ...values })
    .onConflictDoUpdate({ target: [claudeLimits.workspaceId, claudeLimits.credentialSource, claudeLimits.rateLimitType], set: values });
  await publish(run.workspaceId, { type: "limits.updated", windows: await limitWindows(run.workspaceId, run.credentialSource) });

  const [ws] = await db.select({ locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, run.workspaceId));
  const locale = ws?.locale ?? null;
  if (threshold && w.status !== "rejected") {
    const pct = Math.round((w.utilization ?? 0) * 100);
    await publish(run.workspaceId, { type: "limits.warning", window: w.type, threshold, resetsAt: w.resetsAt?.toISOString() ?? null });
    await miscQueue.add("notify", {
      kind: "notify",
      workspaceId: run.workspaceId,
      subject: msg(locale, "notify.limitWarning", { pct, window: windowName(w.type, locale) }),
      text: msg(locale, "notify.limitWarningText", { pct, window: windowName(w.type, locale), resetsAt: when(w.resetsAt, locale) }),
      link: "/dashboard",
    });
  }
  if (w.status === "rejected") {
    await pauseForQuota(run.workspaceId, w.resetsAt, w.type, locale);
    await recordStep({ workspaceId: run.workspaceId, taskId: run.taskId, employeeId: run.employeeId, kind: "budget", name: "subscription_limit", status: "blocked", output: { window: w.type, resetsAt: w.resetsAt } });
    return { rejected: true, resetsAt: w.resetsAt, window: w.type };
  }
  return { rejected: false, resetsAt: w.resetsAt, window: w.type };
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
    await miscQueue.add("notify", { kind: "notify", workspaceId, subject: msg(locale, "notify.limitRejected"), text: reason, link: "/dashboard" });
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
