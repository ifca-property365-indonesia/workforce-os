import type { UptimeStatus } from "@wfos/shared";

/** One bucket of uptime checks: 5 minutes in the one-day view, an hour in the 7- and 30-day views. */
export interface UptimeBucket {
  /** the bucket's start */
  at: string;
  total: number;
  failed: number;
  /** share of good checks, 0–100 */
  okPct: number;
  /** average response time of the good checks, null when none was good */
  avgMs: number | null;
  /** the last failure's short reason (timeout, tls, http 502 …), null when none failed */
  error: string | null;
}

/** consecutive failed checks (2 or more): from the first failed one to the first good one after it (null: still down) */
export interface UptimeIncident {
  from: string;
  to: string | null;
  minutes: number;
}

/** GET /api/apps/[id]/uptime?env=live&days=1|7|30 */
export interface UptimeReport {
  status: UptimeStatus;
  since: string | null;
  checkedAt: string | null;
  certExpiresAt: string | null;
  days: 1 | 7 | 30;
  bucketMinutes: number;
  /** good checks over the asked range, percent (2 decimals), null without checks */
  uptimePct: number | null;
  /** the same over the last 24 h, 7 days and 30 days */
  pct: { day: number | null; week: number | null; month: number | null };
  checks: UptimeBucket[];
  incidents: UptimeIncident[];
}
