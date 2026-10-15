"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ResetSchedule, UsageBudget } from "@wfos/shared/usage-meter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

interface UsageBudgetResponse {
  budget: UsageBudget;
  schedule: ResetSchedule;
  workspaceTimezone: string;
}

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Weekday name in the UI language (2023-01-01 was a Sunday). */
function dayName(locale: string, dow: number): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + dow)));
}
const hourText = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** "12.5" → 12.5, "" → null, anything else → undefined (invalid). */
function usd(v: string): number | null | undefined {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : undefined;
}

/** Owner/Admin: the budget and weekly reset schedule behind the estimated Claude usage meter (display only). */
export function UsageBudgetSettings() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["usage-budget"], queryFn: () => api.get<UsageBudgetResponse>("/api/settings/usage-budget") });
  const [weekly, setWeekly] = useState("");
  const [fiveHour, setFiveHour] = useState("");
  const [dow, setDow] = useState("");
  const [hour, setHour] = useState("");
  const [tz, setTz] = useState("");
  useEffect(() => {
    if (!data) return;
    setWeekly(data.budget.weeklyUsd === null ? "" : String(data.budget.weeklyUsd));
    setFiveHour(data.budget.fiveHourUsd === null ? "" : String(data.budget.fiveHourUsd));
    setDow(data.budget.resetDow === null ? "" : String(data.budget.resetDow));
    setHour(data.budget.resetHour === null ? "" : String(data.budget.resetHour));
    setTz(data.budget.timezone ?? "");
  }, [data]);
  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return [...new Set(["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC", ...(tz ? [tz] : []), ...all])];
  }, [tz]);
  const save = useMutation({
    mutationFn: (b: Partial<UsageBudget>) => api.put<UsageBudgetResponse>("/api/settings/usage-budget", b),
    onSuccess: (r) => {
      qc.setQueryData(["usage-budget"], r);
      void qc.invalidateQueries({ queryKey: ["limits"] });
      toast.success(t("usageBudget.savedToast"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const w = usd(weekly);
  const fh = usd(fiveHour);
  // day and hour go together: both set (custom) or both automatic
  const scheduleOk = (dow === "") === (hour === "");
  const valid = w !== undefined && fh !== undefined && scheduleOk;
  const s = data?.schedule;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("usageBudget.title")}</CardTitle>
        <CardDescription>{t("usageBudget.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="usage-weekly">{t("usageBudget.weekly")}</Label>
          <Input id="usage-weekly" type="number" min={0} step="any" inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} aria-invalid={w === undefined} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="usage-five-hour">{t("usageBudget.fiveHour")}</Label>
          <Input id="usage-five-hour" type="number" min={0} step="any" inputMode="decimal" value={fiveHour} onChange={(e) => setFiveHour(e.target.value)} aria-invalid={fh === undefined} />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">{w === undefined || fh === undefined ? t("usageBudget.invalid") : t("usageBudget.budgetHelp")}</p>
        <div className="space-y-1.5">
          <Label htmlFor="usage-reset-day">{t("usageBudget.resetDay")}</Label>
          <select id="usage-reset-day" className={SELECT} value={dow} onChange={(e) => setDow(e.target.value)} aria-invalid={!scheduleOk}>
            <option value="">{t("usageBudget.automatic")}</option>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {dayName(locale, d)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="usage-reset-hour">{t("usageBudget.resetHour")}</Label>
          <select id="usage-reset-hour" className={SELECT} value={hour} onChange={(e) => setHour(e.target.value)} aria-invalid={!scheduleOk}>
            <option value="">{t("usageBudget.automatic")}</option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourText(h)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="usage-timezone">{t("usageBudget.timezone")}</Label>
          <select id="usage-timezone" className={`${SELECT} max-w-xs`} value={tz} onChange={(e) => setTz(e.target.value)}>
            <option value="">{t("usageBudget.workspaceTz", { tz: data?.workspaceTimezone ?? "" })}</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
          {s && <p>{t("usageBudget.inEffect", { day: dayName(locale, s.resetDow), hour: hourText(s.resetHour), tz: s.timezone, source: t(`usageBudget.source.${s.source}`) })}</p>}
          <p>{t("usageBudget.scheduleHelp")}</p>
        </div>
        <div className="sm:col-span-2">
          <Button
            disabled={!data || !valid || save.isPending}
            onClick={() =>
              save.mutate({
                weeklyUsd: w ?? null,
                fiveHourUsd: fh ?? null,
                resetDow: dow === "" ? null : Number(dow),
                resetHour: hour === "" ? null : Number(hour),
                timezone: tz || null,
              })
            }
          >
            {tc("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
