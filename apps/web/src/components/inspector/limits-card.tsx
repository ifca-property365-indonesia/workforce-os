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

export interface Limits {
  subscription: boolean;
  source: "workspace" | "instance" | null;
  windows: { type: string; status: string; utilization: number | null; resetsAt: string | null; updatedAt: string }[];
  paused: { until: string; reason: string | null } | null;
  usdThisMonth: number;
}

const KNOWN = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

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
  if (!data?.subscription) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4" /> {t("limits.title")}
        </CardTitle>
        <CardDescription>{data.source === "instance" ? t("limits.sharedFallback") : t("limits.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data.windows.length && <p className="text-sm text-muted-foreground">{t("limits.noData")}</p>}
        {data.windows.map((w) => {
          const pct = Math.round((w.utilization ?? 0) * 100);
          return (
            <div key={w.type} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{KNOWN.includes(w.type) ? t(`limits.window.${w.type}`) : w.type}</span>
                <span className={cn("tabular-nums", pct >= 90 ? "text-destructive" : pct >= 70 ? "text-amber-600" : "text-muted-foreground")}>
                  {w.utilization === null ? "—" : t("limits.used", { pct })}
                </span>
              </div>
              <Progress
                value={pct}
                aria-label={KNOWN.includes(w.type) ? t(`limits.window.${w.type}`) : w.type}
                className={cn("h-2", pct >= 90 && "[&>div]:bg-destructive", pct >= 70 && pct < 90 && "[&>div]:bg-amber-500")}
              />
              <div className="text-xs text-muted-foreground">
                {w.status === "rejected" ? t("limits.rejected") : null} {w.resetsAt ? t("limits.resetsAt", { time: f.dateTime(w.resetsAt) }) : t("limits.resetUnknown")}
              </div>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">{t("limits.usd", { usd: f.money(data.usdThisMonth, "USD") })}</p>
      </CardContent>
    </Card>
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
    <div className="flex flex-wrap items-center gap-2 bg-amber-500/20 px-4 py-2 text-sm text-amber-900 dark:text-amber-100">
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
