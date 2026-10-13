"use client";

import Link, { useRouter } from "@/lib/nav";
import { use, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ExternalLink, Pencil, Play, Rocket, Square, Trash2 } from "lucide-react";
import type { ReleaseDTO } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/layout/common";
import { AccessCard } from "@/components/apps/access-card";
import { DeployDialog, EditAppDialog } from "@/components/apps/app-dialogs";
import { EnvEditor } from "@/components/apps/env-editor";
import { ReleasesTable, WarningChips } from "@/components/apps/releases";
import { AppSign, AppStatusBadge, CommitChip, HealthDot, appColors, appsQueryKey, invalidateApp, isActiveRelease, useApp, useApps, useAppRights, useStatusMessage } from "@/components/apps/shared";
import { api } from "@/lib/api";
import { useClients } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

function Tile({ label, children, note, tone }: { label: string; children: ReactNode; note?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-4 py-3">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={cn("font-display mt-0.5 truncate text-2xl sm:text-[1.75rem]", tone)}>{children}</div>
      {note && <div className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

export default function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("apps");
  const f = useFormat();
  const qc = useQueryClient();
  const router = useRouter();
  const withStepUp = useStepUp();
  const statusMessage = useStatusMessage();
  const { data, isLoading, isError } = useApp(id);
  const { data: all } = useApps();
  const { data: clients } = useClients();
  const { admin, logs } = useAppRights();
  const [dialog, setDialog] = useState<"deploy" | "edit" | null>(null);

  const onError = (e: unknown) => toast.error((e as Error).message);
  const action = useMutation({
    mutationFn: (a: "stop" | "start") => api.post(`/api/apps/${id}/${a}`),
    onSuccess: (_r, a) => {
      invalidateApp(qc, id);
      if (data) toast.success(t(a === "stop" ? "actions.stopping" : "actions.starting", { name: data.app.name }));
    },
    onError,
  });
  const rollback = useMutation({
    mutationFn: (r: ReleaseDTO) => api.post(`/api/apps/${id}/rollback`, { releaseId: r.id }),
    onSuccess: () => {
      invalidateApp(qc, id);
      toast.success(t("actions.rollbackQueued"));
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => withStepUp(() => api.del<{ ok: true }>(`/api/apps/${id}`)),
    onSuccess: (r) => {
      if (!r) return;
      toast.success(t("detail.deleting"));
      void qc.invalidateQueries({ queryKey: appsQueryKey });
      router.push("/apps");
    },
    onError,
  });

  const back = (
    <Link href="/apps" className="text-sm text-muted-foreground hover:text-foreground">
      ← {t("detail.back")}
    </Link>
  );
  if (isLoading) return back;
  if (isError || !data)
    return (
      <div className="space-y-4">
        {back}
        <EmptyState icon={<Rocket className="size-8" />} title={t("detail.notFound")} />
      </div>
    );

  const { app, releases } = data;
  const color = appColors((all ?? [app]).map((a) => a.id)).get(app.id) ?? "biru";
  const cur = app.currentRelease;
  const running = releases.some(isActiveRelease) || app.status === "deploying";
  const client = clients?.find((c) => c.id === app.clientId);
  const project = client?.projects.find((p) => p.id === app.projectId);
  const note = statusMessage(app.statusMessage);

  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-3">
          <AppSign app={app} color={color} size="lg" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <AppStatusBadge status={app.status} />
            <HealthDot app={app} withLabel />
            {client && (
              <Link href={`/clients/${client.id}`} className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                {[client.name, project?.name].filter(Boolean).join(" · ")}
              </Link>
            )}
          </div>
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-2 rounded-lg border-2 border-dashed px-3 py-1.5 font-mono text-sm font-semibold transition-colors hover:border-foreground/50"
          >
            <span className="min-w-0 truncate">{app.url.replace(/^https:\/\//, "")}</span>
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{t("detail.open")}</span>
          </a>
          {note && <p className="text-sm text-warning">{note}</p>}
        </div>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <Button className="gap-1.5" disabled={running} onClick={() => setDialog("deploy")}>
              <Rocket className="size-4" aria-hidden /> {t("actions.deploy")}
            </Button>
            {app.status === "running" || app.status === "deploying" || app.status === "failed" ? (
              <Button variant="outline" className="gap-1.5" disabled={action.isPending} onClick={() => confirm(t("actions.stopConfirm", { name: app.name })) && action.mutate("stop")}>
                <Square className="size-4" aria-hidden /> {t("actions.stop")}
              </Button>
            ) : (
              <Button variant="outline" className="gap-1.5" disabled={action.isPending || !cur} onClick={() => action.mutate("start")}>
                <Play className="size-4" aria-hidden /> {t("actions.start")}
              </Button>
            )}
            <Button variant="ghost" className="gap-1.5" onClick={() => setDialog("edit")}>
              <Pencil className="size-4" aria-hidden /> {t("detail.edit")}
            </Button>
          </div>
        )}
      </div>

      {running && <p className="rounded-xl border border-[var(--sign-biru)]/40 bg-[color-mix(in_srgb,var(--sign-biru)_8%,transparent)] px-3 py-2 text-sm">{t("detail.deployingNote")}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("detail.tiles.status")} note={app.lastHealthAt ? t("health.checked", { ago: f.ago(app.lastHealthAt) }) : undefined}>
          {t(`status.${app.status}`)}
        </Tile>
        <Tile
          label={t("detail.tiles.live")}
          note={cur ? [t("detail.deployedAgo", { ago: f.ago(cur.finishedAt ?? cur.createdAt) }), cur.createdByName].filter(Boolean).join(" · ") : undefined}
        >
          {cur ? <CommitChip sha={cur.commit} className="align-middle text-base" /> : <span className="text-muted-foreground">{t("detail.noRelease")}</span>}
        </Tile>
        <Tile label={t("detail.tiles.server")} note={t("detail.port", { port: app.port })}>
          {app.serverName}
        </Tile>
        <Tile label={t("detail.tiles.memory")} note={app.hasDatabase ? t("detail.withDatabase") : undefined}>
          {t("detail.memoryValue", { mb: app.memoryMb })}
        </Tile>
      </div>

      {cur && (cur.commitSubject || cur.warnings.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CommitChip sha={cur.commit} />
          {cur.commitSubject && <span className="min-w-0 truncate">{cur.commitSubject}</span>}
          <WarningChips warnings={cur.warnings} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {app.repositoryName ? t("detail.branchLine", { repository: app.repositoryName, branch: app.branch }) : t("detail.repoMissing")}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <AccessCard app={app} admin={admin} />
        <EnvEditor key={app.envKeys.join(",")} app={app} admin={admin} />
      </div>

      <section className="space-y-3">
        <h2 className="font-display text-[1.7rem] leading-none">{t("releases.title")}</h2>
        <ReleasesTable
          releases={releases}
          origins={data.origins}
          currentId={cur?.id ?? null}
          logs={logs}
          admin={admin && !running}
          rollbackPending={rollback.isPending}
          onRollback={(r) => confirm(t("actions.rollbackConfirm", { commit: r.commit.slice(0, 7) })) && rollback.mutate(r)}
        />
      </section>

      {admin && (
        <section className="flex flex-col gap-3 rounded-xl border border-destructive/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{t("detail.dangerHelp")}</p>
          <Button
            variant="outline"
            className="shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={remove.isPending}
            onClick={() => confirm(t("detail.deleteConfirm", { name: app.name })) && remove.mutate()}
          >
            <Trash2 className="size-4" aria-hidden /> {t("detail.danger")}
          </Button>
        </section>
      )}

      {dialog === "deploy" && <DeployDialog app={app} onClose={() => setDialog(null)} />}
      {dialog === "edit" && <EditAppDialog app={app} onClose={() => setDialog(null)} />}
    </div>
  );
}
