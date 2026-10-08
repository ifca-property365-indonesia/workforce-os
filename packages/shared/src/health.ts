/**
 * Client project health (all date math in the workspace time zone):
 *   late     = past the deadline and not done
 *   at risk  = deadline in fewer than 14 days with progress below 70 %, or no activity in 7 days
 *   on track = otherwise
 */
export type ProjectHealth = "late" | "at_risk" | "on_track" | "done";

export interface HealthInput {
  /** YYYY-MM-DD, a calendar date in the workspace time zone */
  deadline: string | null;
  /** 0..100 */
  progress: number;
  done: boolean;
  /** latest activity (task update, project update); falls back to createdAt */
  lastActivityAt: Date | null;
  createdAt: Date;
}

export const AT_RISK_DAYS = 14;
export const AT_RISK_PROGRESS = 70;
export const STALE_DAYS = 7;

/** Today's calendar date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole calendar days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const toUtc = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y!, m! - 1, day!);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function projectHealth(p: HealthInput, timeZone: string, now = new Date()): { health: ProjectHealth; daysToDeadline: number | null; idleDays: number; reasons: ("past_deadline" | "deadline_soon" | "no_activity")[] } {
  const today = todayIn(timeZone, now);
  const last = p.lastActivityAt ?? p.createdAt;
  const idleDays = daysBetween(todayIn(timeZone, last), today);
  const daysToDeadline = p.deadline ? daysBetween(today, p.deadline) : null;
  if (p.done) return { health: "done", daysToDeadline, idleDays, reasons: [] };
  if (daysToDeadline !== null && daysToDeadline < 0) return { health: "late", daysToDeadline, idleDays, reasons: ["past_deadline"] };
  const reasons: ("deadline_soon" | "no_activity")[] = [];
  if (daysToDeadline !== null && daysToDeadline < AT_RISK_DAYS && p.progress < AT_RISK_PROGRESS) reasons.push("deadline_soon");
  if (idleDays >= STALE_DAYS) reasons.push("no_activity");
  return { health: reasons.length ? "at_risk" : "on_track", daysToDeadline, idleDays, reasons };
}
