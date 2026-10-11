import "server-only";
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
// registers the Indonesian locale on the cronstrue instance above
import "cronstrue/locales/id";
import type { Locale } from "@wfos/shared";

export type CronPreview =
  | { valid: true; label: string; nextRuns: string[] }
  | { valid: false; error: "invalid_timezone" | "invalid_cron" | "cron_fields"; detail: string; label: null; nextRuns: [] };

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A human label for a cron rule ("At 09:00, only on Monday" / "Pada 09:00, hanya pada Senin"); the raw rule when cronstrue cannot read it. */
export function cronLabel(cron: string, locale: Locale): string {
  try {
    return cronstrue.toString(cron, { locale, use24HourTimeFormat: true, throwExceptionOnParseError: true, verbose: false });
  } catch {
    return cron;
  }
}

/**
 * Validate a cron rule in a time zone and list its next firings. Routines take exactly five fields (minute hour
 * day month weekday, as routineInputSchema requires): the parser would also accept a seconds field, which a
 * routine cannot be saved with. `cron_fields` carries the field count found as `detail`.
 */
export function previewCron(cron: string, timezone: string, locale: Locale, count = 3, from = new Date()): CronPreview {
  if (!validTimeZone(timezone)) return { valid: false, error: "invalid_timezone", detail: timezone, label: null, nextRuns: [] };
  const fields = cron.trim().split(/\s+/).filter(Boolean).length;
  if (fields !== 5) return { valid: false, error: "cron_fields", detail: String(fields), label: null, nextRuns: [] };
  try {
    const it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: from });
    const nextRuns: string[] = [];
    for (let i = 0; i < count; i++) nextRuns.push(it.next().toDate().toISOString());
    return { valid: true, label: cronLabel(cron, locale), nextRuns };
  } catch (e) {
    return { valid: false, error: "invalid_cron", detail: (e as Error).message, label: null, nextRuns: [] };
  }
}
