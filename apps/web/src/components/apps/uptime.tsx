"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronDown, ShieldCheck, ShieldAlert, Timer } from "lucide-react";
import { CERT_WARN_DAYS, UPTIME_CHECK_EVERY_MS, type AppEnvironmentDTO, type UptimeStatus } from "@wfos/shared";
import { api } from "@/lib/api";
import type { UptimeBucket, UptimeReport } from "@/lib/uptime";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useNow } from "./release-window";
import { appQueryKey } from "./shared";

const DAY_MS = 86_400_000;
const TICK_MS = 5 * 60_000;
/** 24 h of 5-minute ticks */
const TICKS = DAY_MS / TICK_MS;

/** under ["app", id] so whatever refreshes the app (app.updated, a release) refreshes its uptime too */
export function useUptime(appId: string, days: 1 | 7 | 30, enabled = true) {
  return useQuery({
    queryKey: [...appQueryKey(appId), "uptime", days],
    queryFn: () => api.get<UptimeReport>(`/api/apps/${appId}/uptime?env=live&days=${days}`),
    enabled,
    refetchInterval: UPTIME_CHECK_EVERY_MS,
  });
}

/** the uptime dot: green with a halo while up, red pulsing while down, hollow before the first verdict */
export function UptimeDot({ status, className }: { status: UptimeStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        status === "up" && "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_22%,transparent)]",
        status === "down" && "animate-pulse bg-destructive shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_28%,transparent)] motion-reduce:animate-none",
        status === "unknown" && "border border-muted-foreground/50",
        className,
      )}
      aria-hidden
    />
  );
}

/** the certificate's days left; amber within CERT_WARN_DAYS, red once expired (renewal is automatic: amber is late) */
function CertLine({ at, now }: { at: string | null; now: number }) {
  const t = useTranslations("apps");
  const f = useFormat();
  if (!at) return <p className="text-xs text-muted-foreground">{t("uptime.certUnknown")}</p>;
  const daysLeft = Math.floor((new Date(at).getTime() - now) / DAY_MS);
  const expired = daysLeft < 0;
  const soon = !expired && daysLeft <= CERT_WARN_DAYS;
  const Icon = expired || soon ? ShieldAlert : ShieldCheck;
  return (
    <p className={cn("flex items-center gap-1.5 text-xs", expired ? "font-semibold text-destructive" : soon ? "font-semibold text-warning" : "text-muted-foreground")} title={f.dateTime(at)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {expired ? t("uptime.certExpired", { date: f.date(at) }) : soon ? t("uptime.certSoon", { date: f.date(at), days: daysLeft }) : t("uptime.certValid", { date: f.date(at) })}
    </p>
  );
}

/**
 * The last 24 h as 288 five-minute ticks, oldest left: green a good check, red a failed one, a low grey stub where
 * no check ran (stopped, maintenance, before the first). Each tick's title tells its time, result and response time.
 */
function TickStrip({ buckets, now }: { buckets: UptimeBucket[]; now: number }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const byTick = new Map(buckets.map((b) => [Math.floor(new Date(b.at).getTime() / TICK_MS), b]));
  const last = Math.floor(now / TICK_MS);
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const k = last - (TICKS - 1) + i;
    return { at: new Date(k * TICK_MS), b: byTick.get(k) };
  });
  const checked = buckets.reduce((n, b) => n + b.total, 0);
  const failed = buckets.reduce((n, b) => n + b.failed, 0);
  return (
    <div>
      <div className="flex h-7 items-end gap-px" role="img" aria-label={t("uptime.stripLabel", { checked, failed })}>
        {ticks.map(({ at, b }) => (
          <span
            key={at.getTime()}
            className={cn("min-w-0 flex-1 rounded-[1px]", !b ? "h-2 bg-muted" : b.failed ? "h-full bg-destructive" : "h-5 bg-success/80")}
            title={
              b
                ? `${f.time(at)} · ${b.failed ? t("uptime.tickFailed", { error: b.error ?? "?" }) : t("uptime.tickOk", { ms: b.avgMs === null ? "–" : f.ms(b.avgMs) })}`
                : `${f.time(at)} · ${t("uptime.tickNone")}`
            }
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tracking-wide text-muted-foreground uppercase" aria-hidden>
        <span>{t("uptime.ago24h")}</span>
        <span>{t("uptime.now")}</span>
      </div>
    </div>
  );
}

/** "99.93 %" with the decimals it needs; a dash before any check */
function usePct() {
  const f = useFormat();
  return (v: number | null) => (v === null ? "–" : `${f.number(v, v === 100 ? 0 : 2)} %`);
}

/** past incidents (2+ failed checks in a row) over 30 days, newest first; fetched when opened */
function Incidents({ appId }: { appId: string }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const q = useUptime(appId, 30, open);
  const list = [...(q.data?.incidents ?? [])].reverse();
  return (
    <div>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden /> {t("uptime.incidents")}
      </button>
      {open &&
        (q.isLoading ? null : list.length ? (
          <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto text-xs">
            {list.map((i) => (
              <li key={i.from} className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-destructive/10 px-2 py-1">
                <span className="font-semibold text-destructive">{i.to ? t("uptime.incidentDown", { minutes: i.minutes }) : t("uptime.incidentOngoing", { minutes: i.minutes })}</span>
                <span className="text-muted-foreground">
                  {f.dateTime(i.from)}
                  {i.to ? ` – ${f.time(i.to)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">{t("uptime.noIncidents")}</p>
        ))}
    </div>
  );
}

/**
 * The LIVE panel's uptime block, checked from the platform every 5 minutes: the verdict (up / down / not yet) and
 * since when, uptime over 24 h, 7 and 30 days, the last 24 h as ticks, response time, and the certificate's expiry.
 * Checks pause while the site is stopped or shows its maintenance page.
 */
export function UptimeBlock({ appId, env }: { appId: string; env: AppEnvironmentDTO }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const pct = usePct();
  const q = useUptime(appId, 1);
  const now = useNow(60_000).getTime();
  const r = q.data;
  const status = r?.status ?? env.uptimeStatus;
  const since = r?.since ?? env.uptimeSince;
  const checkedAt = r?.checkedAt ?? env.uptimeCheckedAt;
  const paused = env.status !== "running" || env.maintenance;
  const buckets = r?.checks ?? [];
  const good = buckets.filter((b) => b.avgMs !== null);
  const lastMs = good.at(-1)?.avgMs ?? null;
  const avgMs = good.length ? Math.round(good.reduce((s, b) => s + (b.avgMs ?? 0), 0) / good.length) : null;
  const headline = status === "up" ? t("uptime.up") : status === "down" ? t("uptime.down") : t("uptime.unknown");
  return (
    <section
      className={cn(
        "space-y-3 rounded-lg border bg-background/60 p-3",
        status === "down" && !paused && "border-destructive/50 bg-[color-mix(in_srgb,var(--destructive)_6%,var(--background))]",
      )}
      aria-label={t("uptime.title")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2">
          <UptimeDot status={paused ? "unknown" : status} />
          <span className={cn("font-display text-[1.35rem] leading-none tracking-[0.02em]", status === "down" && !paused && "text-destructive")}>{paused ? t("uptime.paused") : headline}</span>
        </span>
        {!paused && since && status !== "unknown" && (
          <span className="text-xs text-muted-foreground" title={f.dateTime(since)}>
            {t(status === "up" ? "uptime.upSince" : "uptime.downSince", { ago: f.ago(since) })}
          </span>
        )}
        {checkedAt && <span className="ml-auto text-[11px] text-muted-foreground">{t("uptime.checked", { ago: f.ago(checkedAt) })}</span>}
      </div>
      {paused && <p className="text-xs text-muted-foreground">{env.maintenance ? t("uptime.pausedMaintenance") : t("uptime.pausedStopped")}</p>}

      <dl className="grid grid-cols-3 divide-x rounded-md border">
        {(
          [
            ["day", t("uptime.range24h")],
            ["week", t("uptime.range7d")],
            ["month", t("uptime.range30d")],
          ] as const
        ).map(([k, label]) => {
          const v = r?.pct[k] ?? null;
          return (
            <div key={k} className="min-w-0 px-2 py-1.5 text-center">
              <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</dt>
              <dd className={cn("font-display text-[1.25rem] leading-tight tabular-nums", v !== null && v < 99 && "text-warning", v !== null && v < 95 && "text-destructive")}>{pct(v)}</dd>
            </div>
          );
        })}
      </dl>

      <TickStrip buckets={buckets} now={now} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Timer className="size-3.5 shrink-0" aria-hidden />
          {lastMs === null ? t("uptime.responseNone") : t("uptime.response", { ms: f.ms(lastMs), avg: f.ms(avgMs ?? lastMs) })}
        </span>
      </div>
      <CertLine at={r?.certExpiresAt ?? env.certExpiresAt} now={now} />
      <Incidents appId={appId} />
    </section>
  );
}
