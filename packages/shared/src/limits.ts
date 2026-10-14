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
export const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"];

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

/** Weekly window of the OAuth apps (e.g. a `claude setup-token` credential), shown with the other weekly windows. */
export const USAGE_WINDOW_KEYS = ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"] as const;
/** Per-model weekly windows from the usage endpoint's model_scoped[] are stored as `seven_day_model:<display name>`. */
export const MODEL_WINDOW_PREFIX = "seven_day_model:";

/** Two reset times of the same window: within this tolerance (the event and the usage endpoint round differently). */
export const SAME_WINDOW_TOLERANCE_MS = 30 * 60_000;
export function sameWindow(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) <= SAME_WINDOW_TOLERANCE_MS;
}

/** One usage window: utilization in percent (0-100), resets_at ISO. */
type RawUsageWindow = { utilization?: unknown; resets_at?: unknown } | null | undefined;

function usageWindow(type: string, raw: RawUsageWindow): (Omit<LimitWindow, "status"> & { status: LimitStatus | null }) | null {
  if (!raw || typeof raw !== "object") return null;
  const u = typeof raw.utilization === "number" && Number.isFinite(raw.utilization) ? Math.min(1, Math.max(0, raw.utilization / 100)) : null;
  const t = typeof raw.resets_at === "string" ? new Date(raw.resets_at) : null;
  const resetsAt = t && !Number.isNaN(t.getTime()) ? t : null;
  if (u === null && !resetsAt) return null;
  return { type, status: null, utilization: u, resetsAt };
}

/**
 * The plan windows of the Agent SDK's experimental usage call (`query.usage_EXPERIMENTAL_…()`): rate_limits.five_hour,
 * seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet and model_scoped[] ({display_name, utilization,
 * resets_at}), utilization in percent. Returns windows with utilization as a 0..1 fraction (like the stored rows) and
 * no status (the caller derives it, see usageStatus); [] when the response has no plan limits (API key, a token
 * without the profile scope) or is not what is expected. Never throws.
 */
export function usageWindows(resp: unknown): (Omit<LimitWindow, "status"> & { status: LimitStatus | null })[] {
  try {
    if (!resp || typeof resp !== "object") return [];
    const r = resp as { rate_limits_available?: unknown; rate_limits?: unknown };
    if (r.rate_limits_available === false || !r.rate_limits || typeof r.rate_limits !== "object") return [];
    const rl = r.rate_limits as Record<string, unknown>;
    const out: (Omit<LimitWindow, "status"> & { status: LimitStatus | null })[] = [];
    for (const k of USAGE_WINDOW_KEYS) {
      const w = usageWindow(k, rl[k] as RawUsageWindow);
      if (w) out.push(w);
    }
    if (Array.isArray(rl.model_scoped)) {
      for (const m of rl.model_scoped as { display_name?: unknown }[]) {
        const name = typeof m?.display_name === "string" ? m.display_name.trim().slice(0, 60) : "";
        if (!name) continue;
        const w = usageWindow(`${MODEL_WINDOW_PREFIX}${name}`, m as RawUsageWindow);
        if (w) out.push(w);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A status for a window the usage endpoint reported (it has none): rejected at 100 %, allowed_warning from the first
 * warning threshold (70 %), else allowed. A window the CLI already reported as allowed_warning in the same window
 * keeps that; unknown utilization keeps the previous status of the same window (else allowed).
 */
export function usageStatus(utilization: number | null, prev: { status: LimitStatus; sameWindow: boolean } | null): LimitStatus {
  if (utilization === null) return prev?.sameWindow ? prev.status : "allowed";
  if (utilization >= 1) return "rejected";
  if (utilization * 100 >= WARN_THRESHOLDS[0] || (prev?.sameWindow && prev.status === "allowed_warning")) return "allowed_warning";
  return "allowed";
}

/**
 * A stored window as the dashboard shows it: once its reset time has passed, the stored numbers belong to the previous
 * window, so utilization is unknown (null), the status allowed, and `expired` says the window has reset since.
 */
export function displayWindow<T extends { status: string; utilization: number | null; resetsAt: string | null }>(w: T, now: Date = new Date()): T & { expired: boolean } {
  if (!windowExpired(w.resetsAt, now)) return { ...w, expired: false };
  return { ...w, status: "allowed", utilization: null, expired: true };
}

/** A window whose reset time has passed: its stored numbers are from the previous window and must not be shown. */
export function windowExpired(resetsAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!resetsAt) return false;
  const t = typeof resetsAt === "string" ? new Date(resetsAt) : resetsAt;
  return !Number.isNaN(t.getTime()) && t.getTime() <= now.getTime();
}
