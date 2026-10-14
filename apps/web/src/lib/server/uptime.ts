import "server-only";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { appUptimeChecks, db } from "@wfos/db";
import { UPTIME_CHECK_EVERY_MS } from "@wfos/shared";
import type { EnvRow } from "./apps";
import type { UptimeBucket, UptimeIncident, UptimeReport } from "@/lib/uptime";

const DAY_MS = 86_400_000;
/** the ranges the uptime block offers, in days */
export const UPTIME_RANGES = [1, 7, 30] as const;
export type UptimeRange = (typeof UPTIME_RANGES)[number];

/** a failed run counts as an incident from this many consecutive failed checks (the worker's "down" rule) */
export const INCIDENT_MIN_FAILED_CHECKS = 2;

/** more than this between two checks is a gap (stopped, maintenance, worker down): a failed run ends there (the worker's rule) */
export const UPTIME_GAP_MS = 2 * UPTIME_CHECK_EVERY_MS + 60_000;

/**
 * Runs of at least INCIDENT_MIN_FAILED_CHECKS consecutive failed checks, oldest first: from the first failed check to
 * the first good one after it (null while the run lasts). A gap of more than UPTIME_GAP_MS between checks (or since
 * the last one) ends a run at its last failed check, so no incident spans days without checks. Single failed checks
 * (a dropped request) are no incident.
 */
export function incidentsOf(rows: readonly { checkedAt: Date; ok: boolean }[], now: Date): UptimeIncident[] {
  const out: UptimeIncident[] = [];
  let runStart: Date | null = null;
  let runLength = 0;
  let prev: Date | null = null;
  const close = (to: Date | null) => {
    if (runStart && runLength >= INCIDENT_MIN_FAILED_CHECKS) {
      const end = to ?? now;
      out.push({ from: runStart.toISOString(), to: to?.toISOString() ?? null, minutes: Math.max(1, Math.round((end.getTime() - runStart.getTime()) / 60_000)) });
    }
    runStart = null;
    runLength = 0;
  };
  for (const r of rows) {
    if (prev && runStart && r.checkedAt.getTime() - prev.getTime() > UPTIME_GAP_MS) close(prev);
    if (r.ok) close(r.checkedAt);
    else {
      runStart ??= r.checkedAt;
      runLength++;
    }
    prev = r.checkedAt;
  }
  close(prev && now.getTime() - prev.getTime() > UPTIME_GAP_MS ? prev : null);
  return out;
}

/**
 * What the LIVE panel shows of an environment's uptime over the last `days`: the status the worker keeps, the share
 * of good checks over 24 h / 7 d / 30 d, the checks in buckets (5-minute points for one day, hourly ones beyond)
 * and the incidents. Only the environment's own rows of this workspace are read; no response bodies are stored.
 */
export async function uptimeReport(workspaceId: string, env: EnvRow, days: UptimeRange, now = new Date()): Promise<UptimeReport> {
  const mine = and(eq(appUptimeChecks.environmentId, env.id), eq(appUptimeChecks.workspaceId, workspaceId));
  const since = (d: number) => new Date(now.getTime() - d * DAY_MS);
  const after = (d: number) => sql`${appUptimeChecks.checkedAt} > ${since(d).toISOString()}::timestamptz`;
  const [totals] = await db
    .select({
      t1: sql<number>`(count(*) filter (where ${after(1)}))::int`,
      ok1: sql<number>`(count(*) filter (where ${after(1)} and ${appUptimeChecks.ok}))::int`,
      t7: sql<number>`(count(*) filter (where ${after(7)}))::int`,
      ok7: sql<number>`(count(*) filter (where ${after(7)} and ${appUptimeChecks.ok}))::int`,
      t30: sql<number>`count(*)::int`,
      ok30: sql<number>`(count(*) filter (where ${appUptimeChecks.ok}))::int`,
    })
    .from(appUptimeChecks)
    .where(and(mine, gt(appUptimeChecks.checkedAt, since(30))));
  const pct = (ok = 0, total = 0) => (total > 0 ? Math.round((ok / total) * 10_000) / 100 : null);

  // the bucket size comes from the fixed list above, never from the request: safe to inline
  const size = days === 1 ? 300 : 3600;
  const bucket = sql<number>`floor(extract(epoch from ${appUptimeChecks.checkedAt}) / ${sql.raw(String(size))})::int`;
  const rows = await db
    .select({
      b: bucket,
      total: sql<number>`count(*)::int`,
      ok: sql<number>`(count(*) filter (where ${appUptimeChecks.ok}))::int`,
      avgMs: sql<number | null>`(round(avg(${appUptimeChecks.ms}) filter (where ${appUptimeChecks.ok})))::int`,
      error: sql<string | null>`(array_agg(${appUptimeChecks.error} order by ${appUptimeChecks.checkedAt} desc) filter (where not ${appUptimeChecks.ok}))[1]`,
    })
    .from(appUptimeChecks)
    .where(and(mine, gt(appUptimeChecks.checkedAt, since(days))))
    .groupBy(bucket)
    .orderBy(bucket);
  const checks: UptimeBucket[] = rows.map((r) => ({
    at: new Date(Number(r.b) * size * 1000).toISOString(),
    total: r.total,
    failed: r.total - r.ok,
    okPct: r.total > 0 ? Math.round((r.ok / r.total) * 1000) / 10 : 0,
    avgMs: r.avgMs === null ? null : Number(r.avgMs),
    error: r.total > r.ok ? (r.error ?? null) : null,
  }));

  const series = await db
    .select({ checkedAt: appUptimeChecks.checkedAt, ok: appUptimeChecks.ok })
    .from(appUptimeChecks)
    .where(and(mine, gt(appUptimeChecks.checkedAt, since(days))))
    .orderBy(asc(appUptimeChecks.checkedAt));

  const pcts = { day: pct(totals?.ok1, totals?.t1), week: pct(totals?.ok7, totals?.t7), month: pct(totals?.ok30, totals?.t30) };
  return {
    status: env.kind === "live" ? env.uptimeStatus : "unknown",
    since: env.uptimeSince?.toISOString() ?? null,
    checkedAt: env.uptimeCheckedAt?.toISOString() ?? null,
    certExpiresAt: env.certExpiresAt?.toISOString() ?? null,
    days,
    bucketMinutes: size / 60,
    uptimePct: days === 1 ? pcts.day : days === 7 ? pcts.week : pcts.month,
    pct: pcts,
    checks,
    incidents: incidentsOf(series, now),
  };
}
