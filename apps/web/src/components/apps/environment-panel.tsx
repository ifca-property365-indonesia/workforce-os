"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, Construction, DatabaseBackup, ExternalLink, Radio } from "lucide-react";
import { APP_ALT_PORT_OFFSET, type AppEnvironmentDTO, type AppEnvironmentKind } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/lib/use-format";
import { signVars } from "@/lib/sign";
import { cn } from "@/lib/utils";
import { backupStale } from "./backups-panel";
import { DnsStatusChip } from "./dns-panel";
import { WarningChips } from "./releases";
import { AppStatusBadge, CommitChip, EnvPlate, HealthDot, useStatusMessage } from "./shared";

/** the address plate of an environment: dashed like a painted kerb number, the whole host visible */
export function UrlPlate({ url, kind, size = "md" }: { url: string; kind: AppEnvironmentKind; size?: "sm" | "md" }) {
  const t = useTranslations("apps");
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "relative z-10 inline-flex max-w-full items-center gap-2 rounded-lg border-dashed font-mono font-semibold transition-colors hover:border-foreground/50",
        size === "md" ? "border-2 px-3 py-1.5 text-sm" : "border px-2 py-1 text-xs text-muted-foreground hover:text-foreground",
        kind === "live" && "border-[var(--sign-merah)]/55",
      )}
    >
      <span className="min-w-0 truncate">{url.replace(/^https:\/\//, "")}</span>
      <ExternalLink className={cn("shrink-0", size === "md" ? "size-3.5" : "size-3")} aria-hidden />
      <span className="sr-only">{t(kind === "live" ? "detail.openLive" : "detail.open")}</span>
    </a>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 min-w-0 truncate text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * One environment of an app as a panel: its plate (PREVIEW blue / LIVE red, lit while it serves), status and health,
 * the address, the version that runs and where, and the actions this person may take on it.
 */
export function EnvironmentPanel({ env, actions, note }: { env: AppEnvironmentDTO; actions?: ReactNode; note?: ReactNode }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const statusMessage = useStatusMessage();
  const cur = env.currentRelease;
  const message = statusMessage(env.statusMessage);
  const live = env.kind === "live";
  return (
    <section
      className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4", live && "border-[var(--sign-merah)]/40 bg-[color-mix(in_srgb,var(--sign-merah)_4%,var(--card))]")}
      aria-label={t(`environments.${env.kind}`)}
      style={live ? signVars("merah") : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <EnvPlate kind={env.kind} status={env.status} />
        <AppStatusBadge status={env.status} />
        <HealthDot app={env} withLabel />
        {env.maintenance && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-warning">
            <Construction className="size-3" aria-hidden /> {t("detail.maintenance")}
          </span>
        )}
        {live && <DnsStatusChip status={env.dnsCheck?.status ?? null} className="ml-auto" />}
      </div>
      <UrlPlate url={env.url} kind={env.kind} />
      {live && env.extraDomains.length > 0 && (
        <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <ArrowUpRight className="size-3 shrink-0" aria-hidden />
          {t("detail.redirects", { names: env.extraDomains.join(", ") })}
        </p>
      )}
      <div className="space-y-1">
        <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{t(live ? "detail.liveVersion" : "detail.previewVersion")}</div>
        {cur ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <CommitChip sha={cur.commit} className="text-sm" />
              {cur.commitSubject && <span className="min-w-0 truncate text-sm">{cur.commitSubject}</span>}
              <WarningChips warnings={cur.warnings} />
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {[t("detail.deployedAgo", { ago: f.ago(cur.finishedAt ?? cur.createdAt) }), cur.createdByName].filter(Boolean).join(" · ")}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noRelease")}</p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-3">
        <Fact label={t("detail.tiles.server")}>{env.serverName}</Fact>
        <Fact label={t("detail.tiles.port")}>
          {/* live serves from one of two slots (blue = port, green = port + offset); a quiet note of which */}
          {live && env.activeSlot === "green" ? env.port + APP_ALT_PORT_OFFSET : env.port}
          {live && (
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground" title={t("detail.slotHelp")}>
              {t(`detail.slot.${env.activeSlot}`)}
            </span>
          )}
        </Fact>
        <Fact label={t("detail.tiles.memory")}>
          {t("detail.memoryValue", { mb: env.memoryMb })}
          {env.hasDatabase && <span className="text-muted-foreground"> · {t("detail.db")}</span>}
        </Fact>
      </dl>
      {live && env.hasDatabase && <LastBackup env={env} />}
      {message && <p className="text-sm text-warning">{message}</p>}
      {note}
      {actions && <div className="mt-auto flex flex-wrap gap-2 pt-1">{actions}</div>}
    </section>
  );
}

/** live: when the database was last backed up, amber once that is over a day ago on a running site */
function LastBackup({ env }: { env: AppEnvironmentDTO }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const stale = backupStale(env);
  return (
    <p className={cn("flex items-center gap-1.5 text-xs", stale ? "font-medium text-warning" : "text-muted-foreground")} title={env.lastBackupAt ? f.dateTime(env.lastBackupAt) : undefined}>
      <DatabaseBackup className="size-3.5 shrink-0" aria-hidden />
      {env.lastBackupAt ? t("detail.lastBackup", { ago: f.ago(env.lastBackupAt) }) : t("detail.noBackup")}
      {stale && <span className="sr-only">{t("detail.backupStale")}</span>}
    </p>
  );
}

/** the empty LIVE slot: what a live environment is, and the Owner's way to set one up */
export function LiveSlot({ owner, onSetup }: { owner: boolean; onSetup: () => void }) {
  const t = useTranslations("apps");
  return (
    <section
      className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border-2 border-dashed border-[var(--sign-merah)]/35 p-4"
      aria-label={t("environments.live")}
      style={signVars("merah")}
    >
      <div className="space-y-2">
        <EnvPlate kind="live" status="new" />
        <h3 className="font-display text-[1.6rem] leading-none">{t("live.emptyTitle")}</h3>
        <p className="max-w-[52ch] text-sm text-muted-foreground">{t("live.emptyLead")}</p>
      </div>
      {owner ? (
        <Button className="gap-1.5 self-start bg-[var(--sign-merah)] text-white hover:bg-[color-mix(in_srgb,var(--sign-merah)_86%,black)]" onClick={onSetup}>
          <Radio className="size-4" aria-hidden /> {t("live.setup")}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("live.ownerOnly")}</p>
      )}
    </section>
  );
}
