import type { TaskStatus } from "@wfos/shared";

/**
 * Locale-aware formatting (Intl). Components get a bound instance from useFormat();
 * this module stays React-free so it can be unit-tested.
 */
export interface Formatter {
  locale: string;
  /** credits with sensible precision (1 credit = $0.01) */
  credits(n: number | null | undefined): string;
  /** USD equivalent of a credit amount */
  usd(n: number | null | undefined): string;
  /** relative time ("5 menit yang lalu" / "5 min. ago") */
  ago(d: string | Date | null | undefined): string;
  dateTime(d: string | Date | null | undefined): string;
  date(d: string | Date | null | undefined): string;
  time(d: string | Date | null | undefined): string;
  number(n: number | null | undefined, maxFractionDigits?: number): string;
  /** money in a currency; IDR without decimals → "Rp 1.234.567" in id */
  money(n: number | null | undefined, currency?: string): string;
  /** durations in ms → "850 ms" / "1,2 s" */
  ms(n: number): string;
}

const DASH = "—";
const ZERO_DECIMAL = new Set(["IDR", "JPY", "KRW", "VND"]);

function toDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(x.getTime()) ? null : x;
}

export function createFormatter(locale: string, timeZone: string, now: () => number = Date.now): Formatter {
  const num = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, opts);
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const dt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone, ...opts });
  const f: Formatter = {
    locale,
    credits(n) {
      const v = Number(n ?? 0);
      if (v === 0) return num({}).format(0);
      if (Math.abs(v) < 0.01) return num({ maximumFractionDigits: 4, minimumFractionDigits: 4 }).format(v);
      if (Math.abs(v) < 1) return num({ maximumFractionDigits: 3, minimumFractionDigits: 3 }).format(v);
      return num({ maximumFractionDigits: 2 }).format(v);
    },
    usd(n) {
      const v = Number(n ?? 0) * 0.01;
      return num({ style: "currency", currency: "USD", minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 4 : 2 }).format(v);
    },
    ago(d) {
      const x = toDate(d);
      if (!x) return DASH;
      const s = Math.round((x.getTime() - now()) / 1000);
      const a = Math.abs(s);
      if (a < 60) return rel.format(s, "second");
      if (a < 3600) return rel.format(Math.round(s / 60), "minute");
      if (a < 86400) return rel.format(Math.round(s / 3600), "hour");
      return rel.format(Math.round(s / 86400), "day");
    },
    dateTime: (d) => (toDate(d) ? dt({ dateStyle: "medium", timeStyle: "short" }).format(toDate(d)!) : DASH),
    date: (d) => (toDate(d) ? dt({ dateStyle: "medium" }).format(toDate(d)!) : DASH),
    time: (d) => (toDate(d) ? dt({ hour: "2-digit", minute: "2-digit" }).format(toDate(d)!) : DASH),
    number: (n, maxFractionDigits = 2) => num({ maximumFractionDigits: maxFractionDigits }).format(Number(n ?? 0)),
    money(n, currency = "IDR") {
      const code = currency.toUpperCase();
      const digits = ZERO_DECIMAL.has(code) ? 0 : 2;
      try {
        return num({ style: "currency", currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(n ?? 0));
      } catch {
        return `${code} ${num({ maximumFractionDigits: 2 }).format(Number(n ?? 0))}`;
      }
    },
    ms: (n) => (n < 1000 ? num({ style: "unit", unit: "millisecond", unitDisplay: "short" }).format(n) : num({ style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 1 }).format(n / 1000)),
  };
  return f;
}

export const STATUS_TONE: Record<TaskStatus, string> = {
  QUEUED: "bg-secondary text-secondary-foreground",
  RUNNING: "bg-primary/15 text-primary",
  AWAITING_APPROVAL: "bg-warning/20 text-amber-700 dark:text-amber-300",
  DONE: "bg-success/15 text-emerald-700 dark:text-emerald-300",
  FAILED: "bg-destructive/15 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};
