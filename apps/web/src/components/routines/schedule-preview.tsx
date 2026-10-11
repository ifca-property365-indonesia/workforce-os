"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { createFormatter } from "@/lib/format";

export interface SchedulePreview {
  valid: boolean;
  error?: string;
  label: string | null;
  nextRuns: string[];
  /** the workspace's time zone, which the next runs are shown in */
  displayTimezone: string;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * POST /api/routines/preview for a rule; `debounceMs` for live typing. `pending`: the shown answer is not for the
 * rule as typed yet (still debouncing, or the request is in flight) — callers show a cue instead of the old label.
 */
export function useSchedulePreview(cron: string, timezone: string, debounceMs = 0): { data: SchedulePreview | undefined; pending: boolean } {
  const c = useDebounced(cron.trim(), debounceMs);
  const tz = useDebounced(timezone.trim(), debounceMs);
  const q = useQuery({
    queryKey: ["routine-preview", c, tz],
    queryFn: () => api.post<SchedulePreview>("/api/routines/preview", { cron: c, timezone: tz }),
    enabled: !!c && !!tz,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const asked = !!cron.trim() && !!timezone.trim();
  const settling = c !== cron.trim() || tz !== timezone.trim();
  return { data: asked ? q.data : undefined, pending: asked && (settling || q.isFetching) };
}

/**
 * The rule in words and the next three firings, in the workspace time zone. A polite live region, so screen
 * readers hear the new meaning (or the error) once the rule settles; while it is being checked only a cue shows.
 */
export function SchedulePreviewView({ data, pending = false, compact = false }: { data: SchedulePreview | undefined; pending?: boolean; compact?: boolean }) {
  const t = useTranslations("routines");
  const locale = useLocale();
  const f = useMemo(() => (data ? createFormatter(locale, data.displayTimezone) : null), [locale, data]);
  let body: ReactNode = null;
  if (pending) {
    body = (
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden /> {t("preview.checking")}
      </p>
    );
  } else if (data && f) {
    body = !data.valid ? (
      <p className="text-xs text-destructive">{data.error}</p>
    ) : (
      <div className={compact ? "space-y-0.5 text-xs" : "space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs"}>
        <div className="font-medium text-foreground">{data.label}</div>
        <div className="text-muted-foreground">
          {t("preview.nextRuns", { timezone: data.displayTimezone })}{" "}
          {data.nextRuns.map((r) => f.dateTime(r)).join(" · ")}
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {body}
    </div>
  );
}

/** Live preview under the cron field (debounced while typing). */
export function LiveSchedulePreview({ cron, timezone }: { cron: string; timezone: string }) {
  const { data, pending } = useSchedulePreview(cron, timezone, 400);
  return <SchedulePreviewView data={data} pending={pending} />;
}
