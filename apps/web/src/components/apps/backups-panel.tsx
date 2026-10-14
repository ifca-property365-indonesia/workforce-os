"use client";

import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { DatabaseBackup, HardDrive, History, TriangleAlert } from "lucide-react";
import type { AppBackupDTO, AppBackupKind, AppDTO, AppEnvironmentDTO } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { EnvPlate, appQueryKey, envQuery, invalidateApp } from "./shared";

/** ["app", id, "backups", kind]: under the app's key, so every app.updated refresh reloads it too */
export const backupsQueryKey = (appId: string, kind: AppEnvironmentDTO["kind"]) => [...appQueryKey(appId), "backups", kind] as const;

/** a running live site with a database whose last backup is older than this is flagged (daily backups + slack) */
export const BACKUP_STALE_MS = 26 * 3600_000;

/** Is the environment's last backup too old (or missing) for a running live site with a database? */
export function backupStale(env: Pick<AppEnvironmentDTO, "kind" | "status" | "hasDatabase" | "lastBackupAt" | "lastDeployedAt">, now = Date.now()): boolean {
  if (env.kind !== "live" || env.status !== "running" || !env.hasDatabase) return false;
  // never backed up: only once it has been live long enough for the daily backup to have run
  const since = env.lastBackupAt ?? env.lastDeployedAt;
  return !!since && now - new Date(since).getTime() > BACKUP_STALE_MS;
}

/** "1,4 MB" in the UI's language (Intl units), "—" when the size is not known */
export function formatBytes(locale: string, n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return new Intl.NumberFormat(locale, { style: "unit", unit: units[i], unitDisplay: "short", maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v);
}

const KIND_TONE: Record<AppBackupKind, string> = {
  pre_migrate: "bg-[color-mix(in_srgb,var(--sign-biru)_20%,transparent)] text-foreground",
  daily: "bg-muted text-muted-foreground",
  manual: "bg-success/15 text-success",
  pre_restore: "bg-warning/20 text-warning",
};

function KindChip({ kind }: { kind: AppBackupKind }) {
  const t = useTranslations("apps");
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase", KIND_TONE[kind])}>
      {t(`backups.kind.${kind}`)}
    </span>
  );
}

/**
 * The database backups of one environment: what is on its server (kind, time, size, who), "Back up now" and a
 * "Restore…" per backup. Backing up is the Admins' on the preview and the Owner's on live; a restore is always the
 * Owner's, with a step-up and the domain typed. The backups live on the app server only.
 */
export function BackupsPanel({
  app,
  env,
  canBackup,
  canRestore,
  busy,
}: {
  app: Pick<AppDTO, "id">;
  env: AppEnvironmentDTO;
  canBackup: boolean;
  canRestore: boolean;
  /** a release of this environment waits or runs: backups and restores wait */
  busy: boolean;
}) {
  const t = useTranslations("apps");
  const f = useFormat();
  const qc = useQueryClient();
  // after "Back up now": poll until a new backup shows up (or for three minutes)
  const [awaiting, setAwaiting] = useState<{ newest: string | null; until: number } | null>(null);
  const [restoring, setRestoring] = useState<AppBackupDTO | null>(null);
  const q = useQuery({
    queryKey: backupsQueryKey(app.id, env.kind),
    queryFn: () => api.get<{ backups: AppBackupDTO[] }>(`/api/apps/${app.id}/backups${envQuery(env.kind)}`).then((r) => r.backups),
    refetchInterval: awaiting ? 4000 : false,
  });
  const backups = q.data ?? [];
  const newestId = backups[0]?.id ?? null;
  useEffect(() => {
    if (!awaiting) return;
    if (newestId !== awaiting.newest) {
      setAwaiting(null);
      return;
    }
    const left = awaiting.until - Date.now();
    const timer = setTimeout(() => setAwaiting(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [awaiting, newestId]);

  const backup = useMutation({
    mutationFn: () => api.post(`/api/apps/${app.id}/backups${envQuery(env.kind)}`),
    onSuccess: () => {
      setAwaiting({ newest: newestId, until: Date.now() + 3 * 60_000 });
      toast.success(t("backups.queued"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const stale = backupStale(env);
  const live = env.kind === "live";

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-labelledby={`backups-${env.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <DatabaseBackup className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 space-y-1">
            <h2 id={`backups-${env.id}`} className="text-sm font-semibold">
              {t("backups.title")}
            </h2>
            <p className="max-w-[70ch] text-sm text-muted-foreground">{live ? t("backups.liveHelp") : t("backups.previewHelp")}</p>
          </div>
        </div>
        {canBackup && (
          <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={busy || backup.isPending || !!awaiting} onClick={() => backup.mutate()}>
            <DatabaseBackup className={cn("size-3.5", awaiting && "animate-pulse motion-reduce:animate-none")} aria-hidden />
            {awaiting ? t("backups.running") : t("backups.now")}
          </Button>
        )}
      </div>

      {stale && (
        <p className="flex gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>{env.lastBackupAt ? t("backups.stale", { ago: f.ago(env.lastBackupAt) }) : t("backups.staleNever")}</span>
        </p>
      )}

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("backups.loading")}</p>
      ) : !backups.length ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("backups.empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {backups.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <KindChip kind={b.kind} />
              <time className="min-w-0 text-sm font-medium" dateTime={b.createdAt} title={b.name}>
                {f.dateTime(b.createdAt)}
              </time>
              <span className="min-w-0 text-xs text-muted-foreground">
                {[f.ago(b.createdAt), formatBytes(f.locale, b.sizeBytes), b.createdByName ?? (b.kind === "daily" ? t("backups.bySchedule") : null)].filter(Boolean).join(" · ")}
              </span>
              {canRestore && (
                <Button type="button" size="sm" variant="ghost" className="ml-auto h-8 gap-1.5" disabled={busy} onClick={() => setRestoring(b)}>
                  <History className="size-3.5" aria-hidden /> {t("backups.restore")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="flex gap-1.5 text-xs text-muted-foreground">
        <HardDrive className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{t("backups.serverOnly")}</span>
      </p>
      {!canRestore && backups.length > 0 && <p className="text-xs text-muted-foreground">{t("backups.restoreOwnerOnly")}</p>}

      {restoring && <RestoreDialog app={app} env={env} backup={restoring} onClose={() => setRestoring(null)} onDone={() => invalidateApp(qc, app.id)} />}
    </section>
  );
}

/**
 * The last word before a database is put back to an earlier backup: what is lost (everything written since), that
 * the current database is backed up first and the site shows a maintenance page meanwhile; the Owner types the
 * environment's domain and confirms with a step-up.
 */
export function RestoreDialog({
  app,
  env,
  backup,
  onClose,
  onDone,
}: {
  app: Pick<AppDTO, "id">;
  env: AppEnvironmentDTO;
  backup: AppBackupDTO;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const f = useFormat();
  const uid = useId();
  const withStepUp = useStepUp();
  const [typed, setTyped] = useState("");
  const ok = typed.trim().toLowerCase() === env.domain;
  const m = useMutation({
    mutationFn: () => withStepUp(() => api.post<{ ok: true }>(`/api/apps/${app.id}/restore${envQuery(env.kind)}`, { backupId: backup.id, confirm: typed.trim().toLowerCase() })),
    onSuccess: (r) => {
      if (!r) return;
      onDone();
      toast.success(t("backups.restoreQueued"));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {t("backups.restoreTitle")} <EnvPlate kind={env.kind} status={env.status} />
          </DialogTitle>
          <DialogDescription>{t("backups.restoreDescription", { domain: env.domain })}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) m.mutate();
          }}
        >
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5">
            <KindChip kind={backup.kind} />
            <span className="text-sm font-medium">{f.dateTime(backup.createdAt)}</span>
            <span className="text-xs text-muted-foreground">
              {f.ago(backup.createdAt)} · {formatBytes(f.locale, backup.sizeBytes)}
            </span>
          </div>
          <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
            <p className="flex gap-1.5 font-semibold text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              {t("backups.restoreLoss", { time: f.dateTime(backup.createdAt) })}
            </p>
            <p className="text-muted-foreground">{t("backups.restoreSafety")}</p>
            <p className="text-muted-foreground">{env.kind === "live" ? t("backups.restoreMaintenance") : t("backups.restoreDowntime")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-domain`}>{t.rich("backups.restoreType", { domain: env.domain, b: (c) => <code className="font-mono font-semibold text-foreground">{c}</code> })}</Label>
            <Input id={`${uid}-domain`} autoFocus value={typed} autoCapitalize="none" spellCheck={false} autoComplete="off" className="font-mono" onChange={(e) => setTyped(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">{t("backups.restoreAudited")}</p>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} variant="destructive" className="gap-1.5" disabled={!ok || m.isPending}>
            <History className="size-4" aria-hidden /> {t("backups.restoreConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
