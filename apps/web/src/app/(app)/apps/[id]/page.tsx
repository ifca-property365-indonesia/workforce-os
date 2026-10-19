"use client";

import Link, { useRouter } from "@/lib/nav";
import { use, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Play, Radio, Rocket, Settings2, Square, Trash2 } from "lucide-react";
import type { AppEnvironmentDTO, AppEnvironmentKind, ReleaseDTO } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/layout/common";
import { AccessCard } from "@/components/apps/access-card";
import { TestUsersCard } from "@/components/apps/test-users-card";
import { AppTestsPanel } from "@/components/apps/app-tests-panel";
import { AppDocumentsPanel } from "@/components/apps/app-documents-panel";
import { AppModulesPanel, useAppModules } from "@/components/apps/app-modules-panel";
import { AppDesignCard } from "@/components/apps/ui-templates";
import { BackupsPanel } from "@/components/apps/backups-panel";
import { DeployDialog, EditAppDialog } from "@/components/apps/app-dialogs";
import { DnsPanel } from "@/components/apps/dns-panel";
import { EnvEditor } from "@/components/apps/env-editor";
import { EnvironmentPanel, LiveSlot } from "@/components/apps/environment-panel";
import { ReleaseWindowNote, releaseWindowState, useNow } from "@/components/apps/release-window";
import { UptimeBlock } from "@/components/apps/uptime";
import { UnmergedWork } from "@/components/apps/unmerged-work";
import { ConfirmLiveRemovalDialog, EditLiveDialog, ReleaseToLiveDialog, SetupLiveDialog } from "@/components/apps/live-dialogs";
import { ReleasesTable } from "@/components/apps/releases";
import { AppSign, EnvPlate, appColors, appSignStatus, appsQueryKey, envQuery, invalidateApp, isActiveRelease, useApp, useApps, useAppRights } from "@/components/apps/shared";
import { api } from "@/lib/api";
import { useClients } from "@/lib/hooks";
import { cn } from "@/lib/utils";

type Dialog = "deploy" | "edit" | "setupLive" | "editLive" | "releaseLive" | "removeLive" | "removeApp" | null;

export default function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("apps");
  const qc = useQueryClient();
  const router = useRouter();
  const withStepUp = useStepUp();
  const { data, isLoading, isError } = useApp(id);
  const { data: all } = useApps();
  const { data: clients } = useClients();
  const { admin, owner, logs } = useAppRights();
  const { data: mods } = useAppModules(id, logs);
  const moduleNames = Object.fromEntries((mods?.modules ?? []).map((m) => [m.id, m.name]));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tab, setTab] = useState<AppEnvironmentKind | null>(null);
  const now = useNow();

  const onError = (e: unknown) => toast.error((e as Error).message);
  /** live start / rollback need the Owner's step-up; preview ones go straight through */
  const send = <T,>(kind: AppEnvironmentKind, fn: () => Promise<T>) => (kind === "live" ? withStepUp(fn) : fn());
  const action = useMutation({
    mutationFn: ({ a, env }: { a: "stop" | "start"; env: AppEnvironmentDTO }) =>
      send(a === "start" ? env.kind : "preview", () => api.post(`/api/apps/${id}/${a}${envQuery(env.kind)}`)),
    onSuccess: (r, { a, env }) => {
      if (r === undefined) return;
      invalidateApp(qc, id);
      if (data) toast.success(t(a === "stop" ? "actions.stopping" : "actions.starting", { name: `${data.app.name} · ${t(`environments.${env.kind}`)}` }));
    },
    onError,
  });
  const rollback = useMutation({
    mutationFn: (r: ReleaseDTO) => send(r.environmentKind, () => api.post(`/api/apps/${id}/rollback${envQuery(r.environmentKind)}`, { releaseId: r.id })),
    onSuccess: (r) => {
      if (r === undefined) return;
      invalidateApp(qc, id);
      toast.success(t("actions.rollbackQueued"));
    },
    onError,
  });
  const remove = useMutation({
    // with a live site the Owner types its domain (`confirm`)
    mutationFn: (confirm?: string) => withStepUp(() => api.del<{ ok: true }>(`/api/apps/${id}`, confirm ? { confirm } : undefined)),
    onSuccess: (r) => {
      if (!r) return;
      toast.success(t("detail.deleting"));
      void qc.invalidateQueries({ queryKey: appsQueryKey });
      router.push("/apps");
    },
    onError,
  });
  const removeLive = useMutation({
    mutationFn: (confirm: string) => withStepUp(() => api.del<{ ok: true }>(`/api/apps/${id}/live`, { confirm })),
    onSuccess: (r) => {
      if (!r) return;
      setDialog(null);
      toast.success(t("live.removing"));
      invalidateApp(qc, id);
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
  const { preview, live } = app;
  const color = appColors((all ?? [app]).map((a) => a.id)).get(app.id) ?? "biru";
  const activeIn = (kind: AppEnvironmentKind) => releases.some((r) => r.environmentKind === kind && isActiveRelease(r));
  const previewBusy = activeIn("preview") || preview.status === "deploying";
  const liveBusy = !!live && (activeIn("live") || live.status === "deploying");
  const client = clients?.find((c) => c.id === app.clientId);
  const project = client?.projects.find((p) => p.id === app.projectId);
  // the settings below show one environment: the live one first while its DNS still needs work
  const shownTab: AppEnvironmentKind = live ? (tab ?? (live.dnsCheck?.status === "ok" ? "preview" : "live")) : "preview";
  const shownEnv = shownTab === "live" && live ? live : preview;
  const isOn = (env: AppEnvironmentDTO) => env.status === "running" || env.status === "deploying" || env.status === "failed";

  const liveOn = !!live && (isOn(live) || liveBusy);
  /** outside the live release window a release waits (rollbacks never do) */
  const liveWindow = releaseWindowState(live?.releaseWindow ?? null, now);
  /** stop: Admins on the preview, the Owner on live; start: likewise, and live only once its DNS is ok */
  const stopStart = (env: AppEnvironmentDTO, mayStop: boolean, mayStart: boolean) =>
    isOn(env) ? (
      mayStop && (
        <Button
          variant="outline"
          className="gap-1.5"
          disabled={action.isPending}
          onClick={() => confirm(t(env.kind === "live" ? "actions.stopLiveConfirm" : "actions.stopConfirm", { name: app.name, domain: env.domain })) && action.mutate({ a: "stop", env })}
        >
          <Square className="size-4" aria-hidden /> {t("actions.stop")}
        </Button>
      )
    ) : (
      mayStart && (
        <Button
          variant="outline"
          className="gap-1.5"
          disabled={action.isPending || !env.currentRelease || (env.kind === "live" && env.dnsCheck?.status !== "ok")}
          onClick={() => action.mutate({ a: "start", env })}
        >
          <Play className="size-4" aria-hidden /> {t("actions.start")}
        </Button>
      )
    );

  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-3">
          <AppSign app={{ name: app.name, status: appSignStatus(app) }} color={color} size="lg" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
            {client && (
              <Link href={`/clients/${client.id}`} className="underline-offset-2 hover:text-foreground hover:underline">
                {[client.name, project?.name].filter(Boolean).join(" · ")}
              </Link>
            )}
            <span className="text-xs">{app.repositoryName ? t("detail.branchLine", { repository: app.repositoryName, branch: app.branch }) : t("detail.repoMissing")}</span>
          </div>
        </div>
        {admin && (
          <Button variant="ghost" className="gap-1.5 self-start lg:self-auto" onClick={() => setDialog("edit")}>
            <Pencil className="size-4" aria-hidden /> {t("detail.edit")}
          </Button>
        )}
      </div>

      {(previewBusy || liveBusy) && (
        <p className="rounded-xl border border-[var(--sign-biru)]/40 bg-[color-mix(in_srgb,var(--sign-biru)_8%,transparent)] px-3 py-2 text-sm">
          {liveBusy ? t("detail.deployingLiveNote") : t("detail.deployingNote")}
        </p>
      )}

      {app.repositoryId && <UnmergedWork repositoryId={app.repositoryId} />}

      {/* the two shopfronts: the preview everyone tries, and the client's live site */}
      <div className="grid gap-4 lg:grid-cols-2">
        <EnvironmentPanel
          env={preview}
          actions={
            admin && (
              <>
                <Button className="gap-1.5" disabled={previewBusy} onClick={() => setDialog("deploy")}>
                  <Rocket className="size-4" aria-hidden /> {t("actions.deploy")}
                </Button>
                {stopStart(preview, true, true)}
              </>
            )
          }
        />
        {live ? (
          <EnvironmentPanel
            env={live}
            monitor={(live.currentRelease || live.uptimeCheckedAt) && <UptimeBlock appId={app.id} env={live} />}
            note={
              <>
                {live.dnsCheck?.status !== "ok" && <p className="text-xs text-muted-foreground">{t("live.dnsPending")}</p>}
                <ReleaseWindowNote w={live.releaseWindow} now={now} />
              </>
            }
            actions={
              admin && (
                <>
                  {owner && (
                    <Button
                      className="gap-1.5 bg-[var(--sign-merah)] text-white hover:bg-[color-mix(in_srgb,var(--sign-merah)_86%,black)]"
                      disabled={liveBusy || !liveWindow.open}
                      title={liveWindow.open ? undefined : t("window.releaseWaits")}
                      onClick={() => setDialog("releaseLive")}
                    >
                      <Radio className="size-4" aria-hidden /> {t("live.release")}
                    </Button>
                  )}
                  {stopStart(live, owner, owner)}
                  {owner && (
                    <Button variant="ghost" className="gap-1.5" onClick={() => setDialog("editLive")}>
                      <Settings2 className="size-4" aria-hidden /> {t("live.settings")}
                    </Button>
                  )}
                </>
              )
            }
          />
        ) : (
          <LiveSlot owner={owner} onSetup={() => setDialog("setupLive")} />
        )}
      </div>

      <section className="space-y-3" aria-labelledby="app-settings-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="app-settings-title" className="font-display text-[1.7rem] leading-none">
            {t("detail.settingsTitle")}
          </h2>
          {live && (
            <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label={t("detail.settingsTitle")}>
              {(["preview", "live"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={shownTab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md px-2.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    shownTab === k ? "bg-secondary" : "opacity-60 hover:opacity-100",
                  )}
                >
                  <EnvPlate kind={k} status={k === "live" ? live.status : preview.status} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-4" role={live ? "tabpanel" : undefined}>
          {shownEnv.kind === "live" && <DnsPanel app={app} env={shownEnv} admin={admin} />}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* the live site's password and variables are the Owner's */}
            <AccessCard key={`access-${shownEnv.id}`} app={app} env={shownEnv} admin={shownEnv.kind === "live" ? owner : admin} />
            <EnvEditor key={`${shownEnv.id}-${shownEnv.envKeys.join(",")}`} app={app} env={shownEnv} admin={shownEnv.kind === "live" ? owner : admin} />
          </div>
          {/* C10: the preview's test accounts per role (members see them; showing a password is an Admin's, audited) */}
          {shownEnv.kind === "preview" && logs && <TestUsersCard key={`test-users-${shownEnv.id}`} app={app} admin={admin} />}
          {/* the database's backups: Admins see them; backing up live and every restore are the Owner's */}
          {admin && shownEnv.hasDatabase && (
            <BackupsPanel
              key={`backups-${shownEnv.id}`}
              app={app}
              env={shownEnv}
              canBackup={shownEnv.kind === "live" ? owner : admin}
              canRestore={owner}
              busy={shownEnv.kind === "live" ? liveBusy : previewBusy}
            />
          )}
        </div>
      </section>

      {/* C3: browser tests of the preview (members start one; findings become fix tasks) */}
      {logs && <AppTestsPanel app={app} running={preview.status === "running"} canRun={logs} />}
      {/* C8: modules, each with its own PRD, built one at a time in the app's repository */}
      {logs && <AppModulesPanel app={app} admin={admin} member={logs} />}
      {/* C5: the UI template and Figma file the app follows; "apply the look" as a task */}
      {logs && <AppDesignCard app={app} admin={admin} />}
      {/* C9: PRD, business flow, test guide and presentation, versioned (drafts approved by an Admin) */}
      {logs && <AppDocumentsPanel app={app} admin={admin} member={logs} />}

      <section className="space-y-3">
        <h2 className="font-display text-[1.7rem] leading-none">{t("releases.title")}</h2>
        <ReleasesTable
          releases={releases}
          origins={data.origins}
          moduleNames={moduleNames}
          currentIds={[preview.currentRelease?.id, live?.currentRelease?.id].filter((x): x is string => !!x)}
          logs={logs}
          showEnvironments={!!live || releases.some((r) => r.environmentKind === "live")}
          canRollback={(r) => (r.environmentKind === "live" ? owner && !liveBusy : admin && !previewBusy)}
          rollbackPending={rollback.isPending}
          onRollback={(r) =>
            confirm(t(r.environmentKind === "live" ? "actions.rollbackLiveConfirm" : "actions.rollbackConfirm", { commit: r.commit.slice(0, 7) })) && rollback.mutate(r)
          }
        />
      </section>

      {admin && (
        <section className="space-y-3 rounded-xl border border-destructive/30 p-4">
          {live && owner && (
            <div className="flex flex-col gap-3 border-b border-destructive/20 pb-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {t("live.removeHelp", { domain: live.domain })}
                {liveOn && <span className="mt-1 block text-xs text-warning">{t("live.stopFirst")}</span>}
              </p>
              <Button
                variant="outline"
                className="shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={removeLive.isPending || liveOn}
                onClick={() => setDialog("removeLive")}
              >
                <Trash2 className="size-4" aria-hidden /> {t("live.remove")}
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{live ? t("detail.dangerHelpLive") : t("detail.dangerHelp")}</p>
            <Button
              variant="outline"
              className="shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={remove.isPending || (!!live && (!owner || liveOn))}
              onClick={() => (live ? setDialog("removeApp") : confirm(t("detail.deleteConfirm", { name: app.name })) && remove.mutate(undefined))}
            >
              <Trash2 className="size-4" aria-hidden /> {t("detail.danger")}
            </Button>
          </div>
          {live && !owner && <p className="text-xs text-muted-foreground">{t("detail.deleteNeedsOwner")}</p>}
          {live && owner && liveOn && <p className="text-xs text-warning">{t("live.stopFirst")}</p>}
        </section>
      )}

      {dialog === "deploy" && <DeployDialog app={app} releases={releases} origins={data.origins} onClose={() => setDialog(null)} />}
      {dialog === "edit" && <EditAppDialog app={app} onClose={() => setDialog(null)} />}
      {dialog === "setupLive" && <SetupLiveDialog app={app} onClose={() => setDialog(null)} onCreated={() => setTab("live")} />}
      {dialog === "editLive" && live && <EditLiveDialog app={app} env={live} onClose={() => setDialog(null)} />}
      {dialog === "releaseLive" && live && <ReleaseToLiveDialog app={app} live={live} releases={releases} envChanged={data.liveEnvChanged ?? []} dbPlans={data.dbPlans ?? {}} onClose={() => setDialog(null)} />}
      {dialog === "removeLive" && live && (
        <ConfirmLiveRemovalDialog
          title={t("live.remove")}
          description={t("live.removeConfirm", { domain: live.domain })}
          domain={live.domain}
          pending={removeLive.isPending}
          onConfirm={(typed) => removeLive.mutate(typed)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "removeApp" && live && (
        <ConfirmLiveRemovalDialog
          title={t("detail.danger")}
          description={t("detail.deleteConfirmLive", { name: app.name, domain: live.domain })}
          domain={live.domain}
          pending={remove.isPending}
          onConfirm={(typed) => remove.mutate(typed)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
