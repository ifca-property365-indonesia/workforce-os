"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { useRealtime } from "@/lib/events";
import { useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { MODEL_WINDOW_PREFIX } from "@wfos/shared/limits";
import type { ResetSchedule, UsageBudget, UsageState, WindowMeter } from "@wfos/shared/usage-meter";
import { Link } from "@/lib/nav";

export interface Limits {
  subscription: boolean;
  source: "workspace" | "instance" | null;
  /** expired: the reset time has passed since the last data (the numbers are not shown) */
  windows: { type: string; status: string; utilization: number | null; resetsAt: string | null; updatedAt: string; expired?: boolean }[];
  /** when the newest window was last updated (a run's report or the 15-minute sync) */
  syncedAt?: string | null;
  paused: { until: string; reason: string | null } | null;
  usdThisMonth: number;
  /** large tool results kept behind a handle this month, and the tokens that stayed out of the context (estimate) */
  outputSavings?: { count: number; tokens: number };
  /** estimated 5-hour and weekly usage (workforce-os runs only, display only); null without a subscription */
  meter?: { scope: "workforce_os_only"; budget: UsageBudget; schedule: ResetSchedule; windows: WindowMeter[] } | null;
}

const KNOWN = ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"];

export function useLimits() {
  const qc = useQueryClient();
  useRealtime((ev) => {
    if (ev.type === "limits.updated" || ev.type === "quota.paused" || ev.type === "quota.resumed") void qc.invalidateQueries({ queryKey: ["limits"] });
  });
  return useQuery({ queryKey: ["limits"], queryFn: () => api.get<Limits>("/api/limits"), refetchInterval: 60_000 });
}

/** Claude subscription meter: 5-hour and weekly windows (+ per-model weekly), live over SSE. */
export function LimitsCard() {
  const t = useTranslations("dashboard");
  const f = useFormat();
  const { data } = useLimits();
  const { data: me } = useMe();
  const admin = me?.role === "OWNER" || me?.role === "ADMIN";
  if (!data?.subscription) return null;
  const label = (type: string) =>
    KNOWN.includes(type) ? t(`limits.window.${type}`) : type.startsWith(MODEL_WINDOW_PREFIX) ? t("limits.window.model", { name: type.slice(MODEL_WINDOW_PREFIX.length) }) : type;
  const metered = new Set<string>(data.meter?.windows.map((w) => w.type) ?? []);
  // the 5-hour and weekly rows are part of the meter (with Claude's value when reported); the other windows as before
  const others = data.windows.filter((w) => !metered.has(w.type));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4" /> {t("limits.title")}
        </CardTitle>
        <CardDescription>{data.source === "instance" ? t("limits.sharedFallback") : t("limits.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.meter?.windows.map((w) => <MeterRow key={w.type} w={w} label={label(w.type)} />)}
        {!data.meter && !data.windows.length && <p className="text-sm text-muted-foreground">{t("limits.noData")}</p>}
        {others.map((w) => {
          const pct = Math.round((w.utilization ?? 0) * 100);
          return (
            <div key={w.type} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{label(w.type)}</span>
                <span className={cn("tabular-nums", pct >= 90 ? "text-destructive" : pct >= 70 ? "text-warning" : "text-muted-foreground")}>
                  {w.utilization === null ? "—" : t("limits.used", { pct })}
                </span>
              </div>
              <Progress
                value={pct}
                aria-label={label(w.type)}
                className={cn("h-2", pct >= 90 && "[&>div]:bg-destructive", pct >= 70 && pct < 90 && "[&>div]:bg-warning")}
              />
              <div className="text-xs text-muted-foreground">
                {w.expired ? (
                  // the window reset since the last data: the old numbers and date are not shown
                  t("limits.resetSince")
                ) : (
                  <>
                    {w.status === "rejected" ? t("limits.rejected") : null} {w.resetsAt ? t("limits.resetsAt", { time: f.dateTime(w.resetsAt) }) : t("limits.resetUnknown")}
                  </>
                )}
              </div>
            </div>
          );
        })}
        {data.syncedAt && <p className="text-xs text-muted-foreground">{t("limits.syncedAt", { time: f.dateTime(data.syncedAt) })}</p>}
        <p className="text-xs text-muted-foreground">{t("limits.usd", { usd: f.money(data.usdThisMonth, "USD") })}</p>
        {!!data.outputSavings?.count && (
          <p className="text-xs text-muted-foreground">{t("limits.outputSavings", { count: data.outputSavings.count, tokens: f.number(data.outputSavings.tokens) })}</p>
        )}
        {data.meter && <p className="text-xs text-muted-foreground">{t("limits.meter.scope")}</p>}
        {data.meter && admin && (
          <Link href="/settings?tab=general" className="inline-block text-xs font-semibold underline underline-offset-2">
            {t("limits.meter.setBudget")}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** Tint pills (10–15 %, coloured text): warning is a budget/quota state here, never the solid approval amber. */
const STATE_PILL: Record<UsageState, string> = {
  safe: "bg-success/15 text-success",
  watch: "bg-warning/15 text-warning",
  near: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

/** One window of the estimated meter: the percentage (Claude's fresh value, else the estimate), its basis, spend, projection and reset. */
export function MeterRow({ w, label }: { w: WindowMeter; label: string }) {
  const t = useTranslations("dashboard");
  const f = useFormat();
  const pct = w.utilization === null ? null : Math.round(w.utilization * 100);
  const estimated = w.basis === "calibrated" || w.basis === "budget";
  const basisText =
    w.basis === "reported" && w.reported
      ? t("limits.meter.basis.reported", { time: f.dateTime(w.reported.at) })
      : w.basis === "calibrated" && w.estimate?.calibratedAt
        ? t("limits.meter.basis.calibrated", { time: f.dateTime(w.estimate.calibratedAt) })
        : w.basis === "budget" && w.estimate?.budgetUsd
          ? t("limits.meter.basis.budget", { usd: f.money(w.estimate.budgetUsd, "USD") })
          : t("limits.meter.noBasis");
  const projectedPct = w.projectedUtilization === null ? null : Math.round(w.projectedUtilization * 100);
  return (
    <div className="space-y-1" data-testid={`meter-${w.type}`}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-2">
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATE_PILL[w.state])}>{t(`limits.meter.state.${w.state}`)}</span>
          <span className={cn("tabular-nums", w.state === "near" ? "text-destructive" : w.state === "watch" ? "text-warning" : "text-muted-foreground")}>
            {pct === null ? "—" : estimated ? `≈ ${t("limits.used", { pct })}` : t("limits.used", { pct })}
          </span>
        </span>
      </div>
      <Progress
        value={Math.min(100, pct ?? 0)}
        aria-label={label}
        className={cn(
          "h-2",
          // an estimate is drawn lighter than a value Claude reported
          estimated && "[&>div]:opacity-60",
          w.state === "near" && "[&>div]:bg-destructive",
          w.state === "watch" && "[&>div]:bg-warning",
        )}
      />
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>
          {pct !== null && <span className="font-semibold uppercase tracking-wide">{estimated ? t("limits.meter.estimateLabel") : t("limits.meter.reportedLabel")} · </span>}
          {basisText}
        </p>
        {w.start === null ? (
          <p>{t("limits.meter.notOpen")}</p>
        ) : (
          <p>
            {t("limits.meter.spend", { usd: f.money(w.spendUsd, "USD") })}
            {w.projectedUsd !== null &&
              ` · ${projectedPct !== null ? t("limits.meter.projectedPct", { usd: f.money(w.projectedUsd, "USD"), pct: projectedPct }) : t("limits.meter.projected", { usd: f.money(w.projectedUsd, "USD") })}`}
          </p>
        )}
        {w.reported && w.basis !== "reported" && <p>{t("limits.meter.lastReported", { pct: Math.round(w.reported.utilization * 100), time: f.dateTime(w.reported.at) })}</p>}
        {w.resetsAt && w.windowSource && <p>{t("limits.meter.resetsAt", { time: f.dateTime(w.resetsAt), source: t(`limits.meter.windowSource.${w.windowSource}`) })}</p>}
      </div>
    </div>
  );
}

/** PAUSED_QUOTA banner with the reason, and a resume button for admins. */
export function QuotaBanner() {
  const t = useTranslations("nav");
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data } = useLimits();
  const resume = useMutation({
    mutationFn: () => api.post<{ resumed: number }>("/api/limits/resume"),
    onSuccess: (r) => {
      toast.success(t("quota.resumed", { count: r.resumed }));
      void qc.invalidateQueries({ queryKey: ["limits"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data?.paused) return null;
  const admin = me?.role === "OWNER" || me?.role === "ADMIN";
  return (
    <div className="flex flex-wrap items-center gap-2 bg-warning/20 px-4 py-2 text-sm text-warning">
      <span className="font-semibold">{t("quota.badge")}</span>
      <span>{t("quota.until", { time: f.dateTime(data.paused.until) })}</span>
      {data.paused.reason && <span className="text-xs opacity-80">{data.paused.reason}</span>}
      {admin && (
        <Button size="sm" variant="outline" className="ml-auto h-7" disabled={resume.isPending} onClick={() => resume.mutate()}>
          {t("quota.resumeNow")}
        </Button>
      )}
    </div>
  );
}
