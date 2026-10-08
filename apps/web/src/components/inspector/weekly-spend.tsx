"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useFormat } from "@/lib/use-format";

interface Row {
  week: string;
  employeeId: string | null;
  credits: number;
}
interface Emp {
  id: string;
  name: string;
}

const SLOTS = 7; // slot 8 is folded into "Other"

/** Stacked weekly spend per employee. Color follows the employee (stable order), never rank. */
export function WeeklySpendChart({ rows, employees }: { rows: Row[]; employees: Emp[] }) {
  const t = useTranslations("inspector");
  const f = useFormat();
  const [hover, setHover] = useState<{ week: string; x: number } | null>(null);
  const otherLabel = t("weeklySpend.other");
  // week keys are "YYYY-MM-DD" (start of week), so format them as calendar dates in UTC
  const weekFmt = useMemo(() => new Intl.DateTimeFormat(f.locale, { month: "short", day: "numeric", timeZone: "UTC" }), [f.locale]);
  const weekLabel = (w: string) => {
    const d = new Date(w);
    return Number.isNaN(d.getTime()) ? w : weekFmt.format(d);
  };
  const { weeks, series, max } = useMemo(() => {
    const ordered = [...employees].sort((a, b) => a.id.localeCompare(b.id));
    const named = ordered.slice(0, SLOTS);
    const series = [
      ...named.map((e, i) => ({ id: e.id, name: e.name, color: `var(--series-${i + 1})` })),
      ...(ordered.length > SLOTS || rows.some((r) => !r.employeeId) ? [{ id: "__other", name: otherLabel, color: "var(--series-other)" }] : []),
    ];
    const keyOf = (id: string | null) => (id && named.some((n) => n.id === id) ? id : "__other");
    const weeks = [...new Set(rows.map((r) => r.week))].sort();
    const byWeek = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const m = byWeek.get(r.week) ?? new Map<string, number>();
      m.set(keyOf(r.employeeId), (m.get(keyOf(r.employeeId)) ?? 0) + r.credits);
      byWeek.set(r.week, m);
    }
    const data = weeks.map((w) => ({ week: w, values: series.map((s) => byWeek.get(w)?.get(s.id) ?? 0) }));
    const max = Math.max(1, ...data.map((d) => d.values.reduce((a, b) => a + b, 0)));
    return { weeks: data, series, max };
  }, [rows, employees, otherLabel]);

  if (!weeks.length) return <p className="py-10 text-center text-sm text-muted-foreground">{t("weeklySpend.empty")}</p>;
  const hovered = weeks.find((w) => w.week === hover?.week);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="relative">
        <div className="flex h-48 items-end gap-3 border-b border-border/70" onMouseLeave={() => setHover(null)}>
          {weeks.map((w) => {
            const total = w.values.reduce((a, b) => a + b, 0);
            return (
              <div
                key={w.week}
                className="group flex h-full flex-1 flex-col justify-end"
                onMouseEnter={(e) => setHover({ week: w.week, x: (e.currentTarget as HTMLElement).offsetLeft + (e.currentTarget as HTMLElement).offsetWidth / 2 })}
              >
                <div className="flex flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]" style={{ height: `${(total / max) * 100}%` }}>
                  {w.values.map((v, i) =>
                    v > 0 ? <div key={i} style={{ flexGrow: v, background: series[i]!.color, minHeight: 2 }} className="group-hover:opacity-90" /> : null,
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex gap-3 text-[11px] text-muted-foreground">
          {weeks.map((w) => (
            <div key={w.week} className="flex-1 text-center">
              {weekLabel(w.week)}
            </div>
          ))}
        </div>
        {hovered && hover && (
          <div className="pointer-events-none absolute top-0 z-10 w-48 -translate-x-1/2 rounded-md border bg-popover p-2 text-xs shadow-md" style={{ left: hover.x }}>
            <div className="mb-1 font-medium">{t("weeklySpend.weekOf", { date: weekLabel(hovered.week) })}</div>
            {series.map((s, i) =>
              hovered.values[i] ? (
                <div key={s.id} className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: s.color }} />
                    {s.name}
                  </span>
                  <span className="tabular-nums">{f.credits(hovered.values[i])}</span>
                </div>
              ) : null,
            )}
            <div className="mt-1 flex justify-between border-t pt-1 font-medium">
              <span>{t("weeklySpend.total")}</span>
              <span className="tabular-nums">{f.credits(hovered.values.reduce((a, b) => a + b, 0))}</span>
            </div>
          </div>
        )}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t("weeklySpend.tableView")}</summary>
        <table className="mt-2 w-full text-left">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1">{t("weeklySpend.week")}</th>
              {series.map((s) => (
                <th key={s.id} className="py-1 text-right">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week} className="border-t">
                <td className="py-1">{weekLabel(w.week)}</td>
                {w.values.map((v, i) => (
                  <td key={i} className="py-1 text-right tabular-nums">
                    {f.credits(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
