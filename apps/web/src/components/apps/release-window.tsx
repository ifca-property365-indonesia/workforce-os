"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, Moon } from "lucide-react";
import { isWithinReleaseWindow, type ReleaseWindow } from "@wfos/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WEEK_MONDAY_FIRST, isValidTimeZone, nextReleaseWindowOpening, normaliseDays } from "@/lib/release-window";
import { signVars } from "@/lib/sign";
import { cn } from "@/lib/utils";
import { selectClass } from "./shared";

/** the zones offered first (the platform's clients are in Indonesia); any other valid one stays selectable once set */
// i18n-ignore: IANA time zone names are the same in every language
const ZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "UTC"] as const;

/** the current time, ticking every `everyMs` (a window opens while a page stays open) */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** short weekday names of the UI language, Sunday = 0 (2026-10-11 was a Sunday) */
function useWeekdays(): string[] {
  const locale = useLocale();
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return [0, 1, 2, 3, 4, 5, 6].map((d) => f.format(new Date(Date.UTC(2026, 9, 11 + d))));
  }, [locale]);
}

/** "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri", "every day": consecutive days (Monday first) as ranges */
export function useDaysText(): (days: readonly number[]) => string {
  const t = useTranslations("apps");
  const names = useWeekdays();
  return (days) => {
    const set = new Set(days);
    if (set.size >= 7) return t("window.everyDay");
    // runs of neighbours in the Monday-first week (position i follows i - 1)
    const runs: { from: number; days: number[] }[] = [];
    WEEK_MONDAY_FIRST.forEach((d, i) => {
      if (!set.has(d)) return;
      const last = runs.at(-1);
      if (last && last.from + last.days.length === i) last.days.push(d);
      else runs.push({ from: i, days: [d] });
    });
    return runs.map(({ days: r }) => (r.length >= 3 ? `${names[r[0]!]}–${names[r.at(-1)!]}` : r.map((d) => names[d]).join(", "))).join(", ");
  };
}

/** a window's days, hours and zone in one line: "Mon–Fri · 22:00–05:00 · Asia/Jakarta" */
export function useWindowText(): (w: ReleaseWindow) => string {
  const t = useTranslations("apps");
  const daysText = useDaysText();
  return (w) =>
    [daysText(w.days), w.start === w.end ? t("window.allDay") : `${w.start}–${w.end}${w.end < w.start ? ` ${t("window.nextDayMark")}` : ""}`, w.timeZone].join(" · ");
}

/** a moment on the window's own clock: "Wed 14 Oct, 22:00" */
export function useWindowTime(): (at: Date | string, timeZone: string) => string {
  const locale = useLocale();
  return (at, timeZone) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
    } catch {
      return new Date(at).toISOString();
    }
  };
}

/** whether a LIVE release may start now, and when it may otherwise */
export function releaseWindowState(w: ReleaseWindow | null, now: Date): { open: boolean; opensAt: Date | null } {
  if (!w) return { open: true, opensAt: null };
  try {
    if (isWithinReleaseWindow(w, now)) return { open: true, opensAt: null };
    return { open: false, opensAt: nextReleaseWindowOpening(w, now) };
  } catch {
    // an unknown zone (never stored: the API refuses it) must not break the page; the server decides
    return { open: true, opensAt: null };
  }
}

/**
 * The release window on the LIVE panel and in "Release to LIVE": the window itself, and, outside it, that a release
 * waits until the next opening. Nothing without a window.
 */
export function ReleaseWindowNote({ w, now, className }: { w: ReleaseWindow | null; now: Date; className?: string }) {
  const t = useTranslations("apps");
  const text = useWindowText();
  const time = useWindowTime();
  if (!w) return null;
  const { open, opensAt } = releaseWindowState(w, now);
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs",
        open ? "bg-muted/50 text-muted-foreground" : "border border-warning/40 bg-warning/10 text-foreground",
        className,
      )}
    >
      <CalendarClock className={cn("mt-px size-3.5 shrink-0", !open && "text-warning")} aria-hidden />
      <span className="min-w-0">
        {open ? t("window.openNow", { window: text(w) }) : t("window.closedNow", { window: text(w) })}
        {!open && opensAt && <span className="block font-semibold">{t("window.opensAt", { time: time(opensAt, w.timeZone) })}</span>}
      </span>
    </p>
  );
}

const DEFAULT_WINDOW: ReleaseWindow = { days: [1, 2, 3, 4, 5], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };

/**
 * The release-window part of the LIVE settings: "any time" or "only in a window", the window's days (chips, Monday
 * first), start and end (an end before the start runs past midnight) and its time zone. `value` null = any time.
 */
export function ReleaseWindowFields({ value, onChange }: { value: ReleaseWindow | null; onChange: (w: ReleaseWindow | null) => void }) {
  const t = useTranslations("apps");
  const uid = useId();
  const names = useWeekdays();
  const text = useWindowText();
  const [last, setLast] = useState<ReleaseWindow>(value ?? DEFAULT_WINDOW);
  const w = value;
  const set = (patch: Partial<ReleaseWindow>) => {
    if (!w) return;
    const next = { ...w, ...patch };
    setLast(next);
    onChange(next);
  };
  const zones = w && !(ZONES as readonly string[]).includes(w.timeZone) ? [w.timeZone, ...ZONES] : ZONES;
  const overnight = !!w && w.end < w.start;
  return (
    <fieldset className="space-y-2.5">
      <legend className="text-sm font-medium">{t("window.title")}</legend>
      <p className="text-xs text-muted-foreground">{t("window.help")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          { on: false, label: t("window.anyTime"), help: t("window.anyTimeHelp") },
          { on: true, label: t("window.onlyWindow"), help: t("window.onlyWindowHelp") },
        ].map((o) => (
          <label
            key={String(o.on)}
            className={cn(
              "flex cursor-pointer flex-col rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              !!w === o.on ? "border-foreground bg-secondary/60" : "hover:bg-secondary/40",
            )}
          >
            <input type="radio" name={`${uid}-mode`} checked={!!w === o.on} onChange={() => onChange(o.on ? last : null)} className="sr-only" />
            <span className="text-sm font-semibold">{o.label}</span>
            <span className="text-xs text-muted-foreground">{o.help}</span>
          </label>
        ))}
      </div>
      {w && (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="space-y-1.5">
            <span id={`${uid}-days`} className="text-xs font-medium">
              {t("window.days")}
            </span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${uid}-days`}>
              {WEEK_MONDAY_FIRST.map((d) => {
                const on = w.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    // the last day stays: a window needs at least one
                    onClick={() => (on ? w.days.length > 1 && set({ days: normaliseDays(w.days.filter((x) => x !== d)) }) : set({ days: normaliseDays([...w.days, d]) }))}
                    className={cn(
                      "font-display min-w-11 rounded-md border px-2 pt-1.5 pb-1 text-[0.95rem] leading-none tracking-[0.04em] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      on ? "sign border-transparent" : "text-muted-foreground hover:bg-secondary/50",
                    )}
                    data-state={on ? "lit" : undefined}
                    style={on ? signVars("merah") : undefined}
                  >
                    {names[d]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`${uid}-start`} className="text-xs">
                {t("window.start")}
              </Label>
              <Input id={`${uid}-start`} type="time" step={60} value={w.start} required onChange={(e) => e.target.value && set({ start: e.target.value.slice(0, 5) })} className="font-mono" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-end`} className="text-xs">
                {t("window.end")}
              </Label>
              <Input id={`${uid}-end`} type="time" step={60} value={w.end} required onChange={(e) => e.target.value && set({ end: e.target.value.slice(0, 5) })} className="font-mono" />
            </div>
            <div className="col-span-2 space-y-1 sm:col-span-1">
              <Label htmlFor={`${uid}-tz`} className="text-xs">
                {t("window.timeZone")}
              </Label>
              <select id={`${uid}-tz`} className={selectClass} value={w.timeZone} onChange={(e) => isValidTimeZone(e.target.value) && set({ timeZone: e.target.value })}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {overnight && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Moon className="size-3.5 shrink-0" aria-hidden /> {t("window.overnight", { end: w.end })}
            </p>
          )}
          {w.start === w.end && <p className="text-xs text-muted-foreground">{t("window.sameTimes")}</p>}
          <p className="text-xs font-medium">{t("window.summary", { window: text(w) })}</p>
        </div>
      )}
    </fieldset>
  );
}
