/**
 * Claude subscription limits, from the Agent SDK's `rate_limit_event` (`rate_limit_info`, see sdk.d.ts
 * SDKRateLimitInfo): status allowed | allowed_warning | rejected, rateLimitType five_hour | seven_day |
 * seven_day_opus | seven_day_sonnet | …, utilization, resetsAt. All fields but status are optional.
 */
export type LimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RawRateLimitInfo {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
}

export interface LimitWindow {
  type: string;
  status: LimitStatus;
  /** 0..1, null when unknown */
  utilization: number | null;
  resetsAt: Date | null;
}

export const WARN_THRESHOLDS = [70, 90] as const;

/** Display order: 5-hour, weekly, then per-model weekly windows. */
export const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

/** Normalise one event: resetsAt may be epoch seconds or ms; utilization a fraction or a percentage. */
export function normalizeRateLimit(info: RawRateLimitInfo | null | undefined): LimitWindow | null {
  if (!info || !info.status) return null;
  const status: LimitStatus = info.status === "rejected" ? "rejected" : info.status === "allowed_warning" ? "allowed_warning" : "allowed";
  let utilization: number | null = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? info.utilization : null;
  if (utilization !== null && utilization > 1) utilization = utilization / 100;
  if (utilization !== null) utilization = Math.min(1, Math.max(0, utilization));
  if (status === "rejected" && utilization === null) utilization = 1;
  let resetsAt: Date | null = null;
  if (typeof info.resetsAt === "number" && info.resetsAt > 0) resetsAt = new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt);
  return { type: info.rateLimitType || "five_hour", status, utilization, resetsAt };
}

/** The highest warning threshold (70 or 90) newly crossed, or 0. */
export function newWarning(utilization: number | null, alreadyWarned: number): number {
  if (utilization === null) return 0;
  const pct = utilization * 100;
  const crossed = [...WARN_THRESHOLDS].reverse().find((t) => pct >= t) ?? 0;
  return crossed > alreadyWarned ? crossed : 0;
}
