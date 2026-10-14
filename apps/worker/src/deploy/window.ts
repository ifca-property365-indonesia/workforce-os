import { isWithinReleaseWindow, type ReleaseWindow } from "@wfos/shared";

/**
 * LIVE release windows (Phase B3): when a LIVE release may start. Rollbacks always may; the web refuses earlier
 * (409 live_outside_window), the pipeline's prepare refuses again (nothing touched), and so does request_release's
 * executor (nothing queued).
 */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon, Tue, Wed 22:00–05:00 (Asia/Jakarta)", "every day 22:00–05:00 (…)"; start = end means the whole day */
export function describeWindow(w: ReleaseWindow): string {
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  const which = days.length === 7 ? "every day" : days.map((d) => DAY_NAMES[d]).join(", ");
  const hours = w.start === w.end ? "all day" : `${w.start}–${w.end}${w.end < w.start ? " (to the next day)" : ""}`;
  return `${which} ${hours} (${w.timeZone})`;
}

const STEP_MS = 15 * 60_000;
const HORIZON_MS = 8 * 24 * 60 * 60_000;

/**
 * When the window opens next after `now` (null: it is open now, or it never opens within 8 days). Candidates are the
 * UTC minutes that share the start's minute modulo 15 (every time zone offset in use is a multiple of 15 minutes), so
 * the start minute itself is always among them: at most 8 × 96 checks.
 */
export function nextWindowOpening(w: ReleaseWindow, now: Date = new Date()): Date | null {
  if (isWithinReleaseWindow(w, now)) return null;
  const startMinute = Number(w.start.slice(3, 5)) % 15;
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  // the first candidate after now whose UTC minute ≡ start minute (mod 15)
  let ms = t.getTime() + ((startMinute - (t.getUTCMinutes() % 15) + 15) % 15) * 60_000;
  if (ms <= now.getTime()) ms += STEP_MS;
  for (const end = now.getTime() + HORIZON_MS; ms <= end; ms += STEP_MS) {
    const at = new Date(ms);
    if (isWithinReleaseWindow(w, at)) return at;
  }
  return null;
}

/** "Thu 15 Oct 22:00" in the window's time zone */
export function formatInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at).replace(",", "");
}

/** Refusal text for a LIVE release outside its window (null: inside, or no window) */
export function outsideWindowMessage(w: ReleaseWindow | null | undefined, now: Date = new Date()): string | null {
  if (!w || isWithinReleaseWindow(w, now)) return null;
  const next = nextWindowOpening(w, now);
  return (
    `LIVE releases may only start ${describeWindow(w)}; it is ${formatInZone(now, w.timeZone)} there now, so nothing was changed. ` +
    (next ? `The window opens next ${formatInZone(next, w.timeZone)} (${w.timeZone}).` : "Ask an Owner to check the release window.") +
    " A rollback is always allowed."
  );
}
