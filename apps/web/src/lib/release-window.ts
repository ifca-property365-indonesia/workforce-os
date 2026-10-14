import { isWithinReleaseWindow, type ReleaseWindow } from "@wfos/shared";

/**
 * Release windows (Phase B3), the parts the web needs beside packages/shared's isWithinReleaseWindow: whether a time
 * zone is one Intl knows, and when a window opens next. Browser- and server-safe (no Node APIs).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** the wall clock of `at` in the zone */
function local(timeZone: string, at: Date) {
  const parts = partsFormatter(timeZone).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), hh: Number(get("hour")), mm: Number(get("minute")), day: WEEKDAYS.indexOf(get("weekday")) };
}

/** the instant whose wall clock in the zone is y-m-d hh:mm (two passes settle a DST offset) */
function instantAt(timeZone: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const l = local(timeZone, new Date(guess));
    const seen = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm);
    guess += want - seen;
  }
  return new Date(guess);
}

/** whether the zone is an IANA name this runtime knows (an unknown one would make every window check throw) */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

const hhmm = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));

/**
 * When the window opens next after `at` (null when `at` lies inside it). A window whose start equals its end spans
 * its whole days, so it opens at midnight. Looks at most 8 days ahead (a window is open on at least one weekday).
 */
export function nextReleaseWindowOpening(w: ReleaseWindow, at: Date = new Date()): Date | null {
  if (isWithinReleaseWindow(w, at)) return null;
  const startMin = w.start === w.end ? 0 : hhmm(w.start);
  const today = local(w.timeZone, at);
  for (let k = 0; k <= 8; k++) {
    // the calendar day k days after today in the zone (UTC arithmetic on the date only)
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + k));
    if (!w.days.includes(date.getUTCDay())) continue;
    const open = instantAt(w.timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(startMin / 60), startMin % 60);
    if (open.getTime() > at.getTime()) return open;
  }
  return null;
}

/** the days of a window in order, Monday first (the way the settings chips and the cards list them) */
export const WEEK_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

/** days without repeats, Sunday (0) first: the stored form */
export function normaliseDays(days: readonly number[]): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => days.includes(d));
}

/** the same window (jsonb keeps its own key order, so compare field by field); null is "no window" */
export function sameReleaseWindow(a: ReleaseWindow | null, b: ReleaseWindow | null): boolean {
  if (!a || !b) return a === b;
  const da = normaliseDays(a.days);
  const db = normaliseDays(b.days);
  return a.start === b.start && a.end === b.end && a.timeZone === b.timeZone && da.length === db.length && da.every((d, i) => d === db[i]);
}
