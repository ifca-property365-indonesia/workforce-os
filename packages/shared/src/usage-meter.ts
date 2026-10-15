/**
 * Estimated Claude subscription usage for credentials whose real plan usage is mostly unknown (a `claude setup-token`
 * token: the usage call returns no plan limits and rate_limit_events carry utilization only near a threshold).
 *
 * What is counted is workforce-os's own model spend (steps with a model, in API-equivalent USD), never other use of
 * the same Claude account. Two ways turn that spend into a percentage of the plan window:
 *  - calibration: whenever Claude reports a real utilization for a window, our spend in that window up to that moment
 *    divided by the utilization (in percent) gives usdPerPercent; the recent points give the ratio for estimates;
 *  - the owner's budget (USD per week / per 5 hours), as AIRIS does.
 * Precedence: a fresh real value, then the calibrated estimate, then the budget, else only the spend.
 * Display only: pauses and 70/90 % notifications stay driven by real limit signals.
 */
import { z } from "zod";
import { sameWindow } from "./limits";

export const METER_WINDOWS = ["five_hour", "seven_day"] as const;
export type MeterWindowType = (typeof METER_WINDOWS)[number];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WINDOW_MS: Record<MeterWindowType, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * DAY_MS };

/** A real value reported by Claude overrides the estimate this long. */
export const REPORTED_FRESH_MS = 30 * 60_000;
/** Watch from 80 %, near the limit from 95 %. */
export const WATCH_AT = 0.8;
export const NEAR_AT = 0.95;
/** The weekly projection never extrapolates from less than this much elapsed time (the first hours are noise). */
export const MIN_PROJECTION_ELAPSED_MS = 12 * HOUR_MS;

// ---------------------------------------------------------------------------
// Settings: workspaces.settings.usageBudget
// ---------------------------------------------------------------------------

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The owner's usage budget. Null reset fields = automatic (Claude's last weekly reset, else Sunday 00:00). */
export const usageBudgetSchema = z.object({
  weeklyUsd: z.number().positive().max(1_000_000).nullable().default(null),
  fiveHourUsd: z.number().positive().max(1_000_000).nullable().default(null),
  /** 0 = Sunday … 6 = Saturday */
  resetDow: z.number().int().min(0).max(6).nullable().default(null),
  resetHour: z.number().int().min(0).max(23).nullable().default(null),
  /** IANA zone of resetDow/resetHour; null = the workspace time zone */
  timezone: z
    .string()
    .max(64)
    .refine((v) => validTimeZone(v), { message: "Unknown time zone" })
    .nullable()
    .default(null),
});
export type UsageBudget = z.infer<typeof usageBudgetSchema>;

export function parseUsageBudget(settings: unknown): UsageBudget {
  const raw = settings && typeof settings === "object" ? (settings as { usageBudget?: unknown }).usageBudget : undefined;
  const r = usageBudgetSchema.safeParse(raw ?? {});
  return r.success ? r.data : usageBudgetSchema.parse({});
}

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

/** Wall-clock offset of a time zone at an instant (local − UTC), in ms. */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A wall-clock time (expressed as a UTC timestamp of its fields) in a zone → the real instant. */
function wallToInstant(wallMs: number, timeZone: string): Date {
  const guess = wallMs - tzOffsetMs(timeZone, new Date(wallMs));
  return new Date(wallMs - tzOffsetMs(timeZone, new Date(guess)));
}

export interface ResetSchedule {
  resetDow: number;
  resetHour: number;
  timezone: string;
  /** custom: the owner's setting; claude: derived from Claude's last weekly reset; default: Sunday 00:00 */
  source: "custom" | "claude" | "default";
}

/** Weekday and hour (rounded to the nearest hour) of an instant in a time zone. */
export function scheduleOf(at: Date, timeZone: string): { resetDow: number; resetHour: number } {
  const local = new Date(at.getTime() + 30 * 60_000 + tzOffsetMs(timeZone, at));
  return { resetDow: local.getUTCDay(), resetHour: local.getUTCHours() };
}

/**
 * The weekly reset schedule: the owner's (both day and hour set), else derived from Claude's last known weekly reset
 * (`seven_day` resets_at, in the budget's or workspace's time zone), else Sunday 00:00 in that zone.
 */
export function resolveSchedule(budget: Pick<UsageBudget, "resetDow" | "resetHour" | "timezone">, lastWeeklyReset: Date | null, workspaceTimeZone: string): ResetSchedule {
  const timezone = budget.timezone && validTimeZone(budget.timezone) ? budget.timezone : validTimeZone(workspaceTimeZone) ? workspaceTimeZone : "UTC";
  if (budget.resetDow !== null && budget.resetHour !== null) return { resetDow: budget.resetDow, resetHour: budget.resetHour, timezone, source: "custom" };
  if (lastWeeklyReset && !Number.isNaN(lastWeeklyReset.getTime())) return { ...scheduleOf(lastWeeklyReset, timezone), timezone, source: "claude" };
  return { resetDow: 0, resetHour: 0, timezone, source: "default" };
}

export interface MeterWindow {
  start: Date;
  end: Date;
  /** claude: Claude's own reset time for this window; schedule: the weekly schedule; activity: from our runs */
  source: "claude" | "schedule" | "activity";
}

/** The weekly window containing `now` under a schedule: [last reset at or before now, the next reset). */
export function weekWindow(now: Date, s: Pick<ResetSchedule, "resetDow" | "resetHour" | "timezone">): MeterWindow {
  const localNow = now.getTime() + tzOffsetMs(s.timezone, now);
  const l = new Date(localNow);
  const todayAtReset = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), s.resetHour);
  let back = (l.getUTCDay() - s.resetDow + 7) % 7;
  if (back === 0 && localNow < todayAtReset) back = 7;
  const startWall = todayAtReset - back * DAY_MS;
  return { start: wallToInstant(startWall, s.timezone), end: wallToInstant(startWall + 7 * DAY_MS, s.timezone), source: "schedule" };
}

/** Claude's reset time for a window, when it is still ahead and plausible for that window's length. */
export function liveReset(type: MeterWindowType, resetsAt: Date | null | undefined, now: Date): Date | null {
  if (!resetsAt || Number.isNaN(resetsAt.getTime())) return null;
  const ahead = resetsAt.getTime() - now.getTime();
  return ahead > 0 && ahead <= WINDOW_MS[type] + 30 * 60_000 ? resetsAt : null;
}

/** The current weekly window: Claude's live reset time when known, else the schedule. */
export function sevenDayWindow(now: Date, schedule: ResetSchedule, claudeResetsAt: Date | null): MeterWindow {
  const live = liveReset("seven_day", claudeResetsAt, now);
  if (live) return { start: new Date(live.getTime() - WINDOW_MS.seven_day), end: live, source: "claude" };
  return weekWindow(now, schedule);
}

const floorHour = (d: Date) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/**
 * The current 5-hour window. Claude's live reset time when known. Otherwise the window is derived from our own
 * activity the way Claude opens them: a window starts at the first request after the previous one ended (on the
 * hour) and lasts 5 hours. Walks forward from the last known reset (at most 24 hours back). Null: no window is open
 * (nothing ran since the last one ended); the next run opens one.
 */
export async function fiveHourWindow(
  now: Date,
  claudeResetsAt: Date | null,
  firstActivityAt: (from: Date) => Promise<Date | null>,
): Promise<MeterWindow | null> {
  const live = liveReset("five_hour", claudeResetsAt, now);
  if (live) return { start: new Date(live.getTime() - WINDOW_MS.five_hour), end: live, source: "claude" };
  const floor = now.getTime() - DAY_MS;
  let anchor = new Date(claudeResetsAt && claudeResetsAt.getTime() <= now.getTime() ? Math.max(claudeResetsAt.getTime(), floor) : floor);
  for (let i = 0; i < 12; i++) {
    const first = await firstActivityAt(anchor);
    if (!first || first.getTime() > now.getTime()) return null;
    const start = new Date(Math.max(floorHour(first).getTime(), anchor.getTime()));
    const end = new Date(start.getTime() + WINDOW_MS.five_hour);
    if (end.getTime() > now.getTime()) return { start, end, source: "activity" };
    anchor = end;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationPoint {
  /** when Claude reported the value */
  at: string;
  /** the reported window's reset time (one point per window: a later report in the same window replaces it) */
  windowEnd: string;
  /** our spend in the window up to `at` (USD) */
  spendUsd: number;
  /** Claude's reported utilization, 0..1 */
  utilization: number;
}

/** Below these the ratio is mostly rounding noise (utilization comes in whole percents) or other use of the account. */
export const MIN_CALIBRATION_UTILIZATION = 0.05;
export const MIN_CALIBRATION_SPEND_USD = 0.5;
export const CALIBRATION_MAX_POINTS = 5;
export const CALIBRATION_MAX_AGE_MS = 28 * DAY_MS;
/** A report in the same window within this time of the last point does not replace it (events come in bursts). */
export const CALIBRATION_MIN_INTERVAL_MS = 60_000;

/** A calibration point, or null when the value cannot calibrate (utilization 0 or tiny, spend tiny, not finite). */
export function calibrationPoint(spendUsd: number, utilization: number | null, at: Date, windowEnd: Date): CalibrationPoint | null {
  if (utilization === null || !Number.isFinite(utilization) || !Number.isFinite(spendUsd)) return null;
  if (utilization < MIN_CALIBRATION_UTILIZATION || utilization > 1) return null;
  if (spendUsd < MIN_CALIBRATION_SPEND_USD) return null;
  return { at: at.toISOString(), windowEnd: windowEnd.toISOString(), spendUsd: Math.round(spendUsd * 10000) / 10000, utilization };
}

const validPoint = (p: unknown): p is CalibrationPoint => {
  const x = p as CalibrationPoint;
  return (
    !!x &&
    typeof x.at === "string" &&
    typeof x.windowEnd === "string" &&
    Number.isFinite(new Date(x.at).getTime()) &&
    Number.isFinite(x.spendUsd) &&
    Number.isFinite(x.utilization) &&
    x.utilization > 0
  );
};

/** Recent valid points, oldest first (too old ones and junk dropped). */
export function recentPoints(points: unknown, now: Date): CalibrationPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter(validPoint)
    .filter((p) => now.getTime() - new Date(p.at).getTime() <= CALIBRATION_MAX_AGE_MS)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-CALIBRATION_MAX_POINTS);
}

/**
 * Add a point: a point of the same window replaces that window's point (the later one saw more spend, so it is more
 * precise), unless it came within CALIBRATION_MIN_INTERVAL_MS; keeps the last CALIBRATION_MAX_POINTS recent ones.
 * Returns null when nothing changes.
 */
export function addCalibrationPoint(points: unknown, p: CalibrationPoint, now: Date): CalibrationPoint[] | null {
  const list = recentPoints(points, now);
  const same = list.find((x) => sameWindow(new Date(x.windowEnd), new Date(p.windowEnd)));
  if (same && new Date(p.at).getTime() - new Date(same.at).getTime() < CALIBRATION_MIN_INTERVAL_MS) return null;
  return recentPoints([...list.filter((x) => x !== same), p], now);
}

/** USD per utilization percent from the recent points: total spend over total percent (a utilization-weighted mean). */
export function usdPerPercent(points: unknown, now: Date): { usdPerPercent: number; points: number; latestAt: string } | null {
  const list = recentPoints(points, now);
  if (!list.length) return null;
  const spend = list.reduce((s, p) => s + p.spendUsd, 0);
  const pct = list.reduce((s, p) => s + p.utilization * 100, 0);
  if (!(spend > 0) || !(pct > 0)) return null;
  return { usdPerPercent: spend / pct, points: list.length, latestAt: list[list.length - 1]!.at };
}

/** settings.usageCalibration: points per credential source and window type. */
export type UsageCalibration = Partial<Record<"workspace" | "instance", Partial<Record<MeterWindowType, CalibrationPoint[]>>>>;
export function parseUsageCalibration(settings: unknown): UsageCalibration {
  const raw = settings && typeof settings === "object" ? (settings as { usageCalibration?: unknown }).usageCalibration : undefined;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as UsageCalibration) : {};
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export type UsageState = "safe" | "watch" | "near" | "unknown";
export type UsageBasis = "reported" | "calibrated" | "budget";

export interface ReportedValue {
  utilization: number;
  status: string;
  at: string;
  /** reported within REPORTED_FRESH_MS: it overrides the estimate */
  fresh: boolean;
}

export interface WindowMeter {
  type: MeterWindowType;
  /** null for a 5-hour window not open yet (nothing ran since the last one ended) */
  start: string | null;
  resetsAt: string | null;
  /** where the window boundaries come from: Claude's reset time, the weekly schedule (custom/claude/default), or our runs */
  windowSource: "claude" | "custom" | "claude_schedule" | "default" | "activity" | null;
  /** workforce-os model spend in the window so far (API-equivalent USD) */
  spendUsd: number;
  /** weekly window: spend at the window end at the current pace */
  projectedUsd: number | null;
  /** what is shown: a fresh reported value, else the estimate (never below a value reported earlier in the window) */
  utilization: number | null;
  basis: UsageBasis | null;
  projectedUtilization: number | null;
  /** the estimate itself (also when a fresh reported value is shown) */
  estimate: { utilization: number; basis: "calibrated" | "budget"; calibratedAt: string | null; points: number; usdPerPercent: number | null; budgetUsd: number | null } | null;
  /** the last real value Claude reported in this window */
  reported: ReportedValue | null;
  state: UsageState;
}

export interface EstimateInput {
  type: MeterWindowType;
  now: Date;
  window: { start: Date; end: Date; source: MeterWindow["source"] } | null;
  scheduleSource?: ResetSchedule["source"];
  spendUsd: number;
  /** calibration points of this window type and credential */
  points: unknown;
  budgetUsd: number | null;
  /** the stored claude_limits row of this window type */
  row: { utilization: number | null; status: string; resetsAt: Date | null; updatedAt: Date } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function usageState(utilization: number | null, projected: number | null, rejected: boolean): UsageState {
  if (rejected) return "near";
  if (utilization === null) return "unknown";
  if (utilization >= NEAR_AT) return "near";
  if (utilization >= WATCH_AT || (projected !== null && projected > 1)) return "watch";
  return "safe";
}

/** One window of the meter: precedence fresh reported → calibrated → budget → spend only. */
export function estimateWindow(i: EstimateInput): WindowMeter {
  const { now, window: w } = i;
  const spendUsd = Math.max(0, i.spendUsd);
  // a stored value belongs to the current window when its reset time is still ahead
  const inWindow = !!i.row && i.row.utilization !== null && !!liveReset(i.type, i.row.resetsAt, now);
  const reported: ReportedValue | null = inWindow
    ? { utilization: i.row!.utilization!, status: i.row!.status, at: i.row!.updatedAt.toISOString(), fresh: now.getTime() - i.row!.updatedAt.getTime() <= REPORTED_FRESH_MS }
    : null;

  const cal = usdPerPercent(i.points, now);
  let estimate: WindowMeter["estimate"] = null;
  if (cal) {
    estimate = { utilization: spendUsd / cal.usdPerPercent / 100, basis: "calibrated", calibratedAt: cal.latestAt, points: cal.points, usdPerPercent: cal.usdPerPercent, budgetUsd: null };
  } else if (i.budgetUsd && i.budgetUsd > 0) {
    estimate = { utilization: spendUsd / i.budgetUsd, basis: "budget", calibratedAt: null, points: 0, usdPerPercent: null, budgetUsd: i.budgetUsd };
  }

  let utilization: number | null = null;
  let basis: UsageBasis | null = null;
  if (reported?.fresh) {
    utilization = reported.utilization;
    basis = "reported";
  } else if (estimate) {
    // utilization only grows within a window: an older real value is a floor
    utilization = Math.max(estimate.utilization, reported?.utilization ?? 0);
    basis = estimate.basis;
  }

  // weekly projection at the current pace (the same factor for spend and utilization)
  let projectedUsd: number | null = null;
  let projectedUtilization: number | null = null;
  if (i.type === "seven_day" && w) {
    const elapsed = Math.max(MIN_PROJECTION_ELAPSED_MS, now.getTime() - w.start.getTime());
    const factor = Math.max(1, (w.end.getTime() - w.start.getTime()) / elapsed);
    projectedUsd = round2(spendUsd * factor);
    projectedUtilization = utilization === null ? null : utilization * factor;
  }

  const windowSource: WindowMeter["windowSource"] = !w
    ? null
    : w.source === "schedule"
      ? i.scheduleSource === "custom"
        ? "custom"
        : i.scheduleSource === "claude"
          ? "claude_schedule"
          : "default"
      : w.source;

  return {
    type: i.type,
    start: w?.start.toISOString() ?? null,
    resetsAt: w?.end.toISOString() ?? null,
    windowSource,
    spendUsd: round2(spendUsd),
    projectedUsd,
    utilization,
    basis,
    projectedUtilization,
    estimate,
    reported,
    state: usageState(utilization, projectedUtilization, !!reported?.fresh && reported.status === "rejected"),
  };
}
