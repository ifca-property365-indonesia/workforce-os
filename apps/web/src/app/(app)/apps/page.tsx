"use client";

import Link from "@/lib/nav";
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Copy, OctagonX, Palette, Plus, Rocket } from "lucide-react";
import { APP_MANIFEST_FILE, type AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/common";
import { NewAppDialog, useRepositories, useServers } from "@/components/apps/new-app-dialog";
import { UrlPlate } from "@/components/apps/environment-panel";
import { UptimeDot } from "@/components/apps/uptime";
import { AppSign, AppStatusBadge, CommitChip, EnvPlate, HealthDot, appColors, appSignStatus, appsQueryKey, copyText, useApps, useAppRights, useStatusMessage } from "@/components/apps/shared";
import { api } from "@/lib/api";
import { useClients } from "@/lib/hooks";
import { signVars, type SignColor } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";

// i18n-ignore: a file's content, the same in every language
const MANIFEST_EXAMPLE = `{\n  "type": "nextjs",\n  "health": "/api/health"\n}\n`;

function AppCard({ app, color }: { app: AppDTO; color: SignColor }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const statusMessage = useStatusMessage();
  const { preview, live } = app;
  const cur = preview.currentRelease;
  const note = statusMessage(preview.statusMessage);
  return (
    <li className="group relative flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 transition-shadow hover:shadow-md">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <Link href={`/apps/${app.id}`} className="min-w-0 rounded-md after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
          <AppSign app={{ name: app.name, status: appSignStatus(app) }} color={color} />
          <span className="sr-only">{t("list.open", { name: app.name })}</span>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
          <AppStatusBadge status={preview.status} />
          <HealthDot app={preview} />
        </div>
      </div>
      {/* the address plates sit above the card's own link, so each opens its site itself */}
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          {live && <EnvPlate kind="preview" status={preview.status} />}
          <UrlPlate url={preview.url} kind="preview" size="sm" />
        </span>
        {live && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <EnvPlate kind="live" status={live.status} />
            {live.status === "running" && !live.maintenance && live.uptimeStatus !== "unknown" && (
              <span className="inline-flex shrink-0" title={t(live.uptimeStatus === "up" ? "uptime.up" : "uptime.down")}>
                <UptimeDot status={live.uptimeStatus} />
                <span className="sr-only">{t(live.uptimeStatus === "up" ? "uptime.up" : "uptime.down")}</span>
              </span>
            )}
            <UrlPlate url={live.url} kind="live" size="sm" />
          </span>
        )}
      </div>
      {/* C8: modules are listed on the app, never as apps of their own */}
      {app.modules.total > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("list.modules", { count: app.modules.total })}
          {app.modules.waiting > 0 && <span className="ml-1.5 rounded bg-[var(--sign-biru)]/20 px-1.5 font-semibold text-foreground">{t("list.modulesWaiting", { count: app.modules.waiting })}</span>}
        </p>
      )}
      <div className="mt-auto space-y-1 border-t pt-3 text-xs text-muted-foreground">
        {cur ? (
          <>
            <div className="flex min-w-0 items-center gap-1.5">
              <CommitChip sha={cur.commit} className="text-foreground" />
              <span className="min-w-0 truncate text-foreground/80">{cur.commitSubject ?? cur.branch}</span>
            </div>
            <div className="truncate">
              <time dateTime={cur.finishedAt ?? cur.createdAt} title={f.dateTime(cur.finishedAt ?? cur.createdAt)}>
                {f.ago(cur.finishedAt ?? cur.createdAt)}
              </time>
              {" · "}
              {cur.createdByName ? t("list.by", { name: cur.createdByName }) : t("list.byPlatform")}
            </div>
          </>
        ) : (
          <div>{t("list.never")}</div>
        )}
        {live?.currentRelease && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-semibold text-[var(--sign-merah)]">{t("list.liveVersion")}</span>
            <CommitChip sha={live.currentRelease.commit} className="text-foreground" />
            <span className="min-w-0 truncate">{f.ago(live.currentRelease.finishedAt ?? live.currentRelease.createdAt)}</span>
          </div>
        )}
        {note && <div className="truncate text-warning">{note}</div>}
      </div>
    </li>
  );
}

/** one street of shop signs per client: its name painted on the kerb, its apps in a row */
function ClientRow({ title, apps, colors, href }: { title: string; apps: AppDTO[]; colors: Map<string, SignColor>; href?: string }) {
  const t = useTranslations("apps");
  const running = apps.filter((a) => a.preview.status === "running" || a.live?.status === "running").length;
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b-2 border-foreground/80 pb-1.5">
        <h2 className="font-display text-[1.7rem] leading-none">{href ? <Link href={href} className="hover:underline underline-offset-4">{title}</Link> : title}</h2>
        <span className="text-xs text-muted-foreground">
          {t("list.count", { count: apps.length })} · {t("list.running", { count: running })}
        </span>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {apps.map((a) => (
          <AppCard key={a.id} app={a} color={colors.get(a.id) ?? "biru"} />
        ))}
      </ul>
    </section>
  );
}

function StepRow({ n, done, title, help, children }: { n: number; done: boolean; title: ReactNode; help: string; children?: ReactNode }) {
  const t = useTranslations("apps");
  return (
    <li className="grid grid-cols-[2.25rem_1fr] gap-x-3">
      <span className="sign font-display grid size-9 place-items-center rounded-md text-xl" style={signVars(done ? "hijau" : "kuning")} data-state={done ? "lit" : "off"} aria-hidden>
        {done ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 space-y-2 pb-5">
        <h3 className="pt-1.5 text-sm font-semibold">
          {title} <span className="sr-only">({done ? t("empty.done") : t("empty.todo")})</span>
        </h3>
        <p className="text-sm text-muted-foreground">{help}</p>
        {children}
      </div>
    </li>
  );
}

/** what has to be in place before the first app, ticked off as it is */
function EmptyGuide({ admin, onCreate }: { admin: boolean; onCreate: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const servers = useServers();
  const { logs: member } = useAppRights();
  const repos = useRepositories(member);
  const ready = (servers.data ?? []).filter((s) => s.status === "ready").length;
  const repoCount = repos.data?.length ?? 0;
  return (
    <div className="grid gap-6 rounded-2xl border bg-card p-5 sm:p-7 lg:grid-cols-[1.1fr_1fr]">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="sign grid size-12 place-items-center rounded-lg" style={signVars("biru")} data-state="off" aria-hidden>
            <Rocket className="size-6" />
          </span>
          <h2 className="font-display text-[2rem] leading-none">{t("empty.title")}</h2>
        </div>
        <p className="max-w-[60ch] text-sm text-muted-foreground">{t("empty.lead")}</p>
        {admin && (
          <Button className="gap-1.5" disabled={!ready || !repoCount} onClick={onCreate}>
            <Plus className="size-4" /> {t("empty.create")}
          </Button>
        )}
      </div>
      <ol>
        <StepRow n={1} done={ready > 0} title={t("empty.step1")} help={ready ? t("empty.step1Done", { count: ready }) : t("empty.step1Help")}>
          {!ready && (
            <Link href="/settings?tab=servers" className="text-sm font-semibold underline-offset-2 hover:underline">
              {t("empty.openServers")}
            </Link>
          )}
        </StepRow>
        <StepRow n={2} done={repoCount > 0} title={t("empty.step2")} help={repoCount ? t("empty.step2Done", { count: repoCount }) : t("empty.step2Help")}>
          {!repoCount && admin && (
            <Link href="/settings?tab=repositories" className="text-sm font-semibold underline-offset-2 hover:underline">
              {t("empty.openRepositories")}
            </Link>
          )}
        </StepRow>
        <StepRow n={3} done={false} title={t.rich("empty.step3", { file: APP_MANIFEST_FILE, code: (c) => <code className="font-mono">{c}</code> })} help={t("empty.step3Help")}>
          <div className="relative">
            <pre aria-label={APP_MANIFEST_FILE} className="overflow-x-auto rounded-lg bg-[#1d1922] p-3 pr-11 font-mono text-xs leading-relaxed text-[#e9e1ee]">
              {MANIFEST_EXAMPLE}
            </pre>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute top-1 right-1 size-8 text-[#e9e1ee] hover:bg-white/10 hover:text-white"
              aria-label={t("empty.copyExample")}
              onClick={() => void copyText(MANIFEST_EXAMPLE, tc("copied"), toast)}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("empty.defaults")}</p>
        </StepRow>
      </ol>
    </div>
  );
}

export default function AppsPage() {
  const t = useTranslations("apps");
  const qc = useQueryClient();
  const { data, isLoading } = useApps();
  const { data: clients } = useClients();
  const { admin, owner } = useAppRights();
  const [creating, setCreating] = useState(false);
  const list = data ?? [];
  const colors = appColors(list.map((a) => a.id));
  const previewsOn = list.filter((a) => a.preview.status === "running" || a.preview.status === "deploying").length;

  const stopAll = useMutation({
    mutationFn: () => api.post<{ count: number }>("/api/apps/stop-all"),
    onSuccess: (r) => {
      toast.success(t("stopAllDone", { count: r.count }));
      void qc.invalidateQueries({ queryKey: appsQueryKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // clients by name, apps without a client last
  const names = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const groups = new Map<string, AppDTO[]>();
  for (const a of list) {
    const k = a.clientId && names.has(a.clientId) ? a.clientId : "";
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (!a ? 1 : !b ? -1 : names.get(a)!.localeCompare(names.get(b)!)));

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={
          <>
            {t("description")}
            {!admin && data && <span className="mt-1 block">{t("readOnly")}</span>}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" className="gap-1.5">
              <Link href="/apps/templates">
                <Palette className="size-4" /> {t("templates.open")}
              </Link>
            </Button>
            {owner && previewsOn > 0 && (
              <Button variant="outline" className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={stopAll.isPending} onClick={() => confirm(t("stopAllConfirm")) && stopAll.mutate()}>
                <OctagonX className="size-4" /> {t("stopAll")}
              </Button>
            )}
            {admin && !!list.length && (
              <Button onClick={() => setCreating(true)} className="gap-1.5">
                <Plus className="size-4" /> {t("newApp")}
              </Button>
            )}
          </>
        }
      />
      {!isLoading && !list.length && <EmptyGuide admin={admin} onCreate={() => setCreating(true)} />}
      {ordered.map(([k, apps]) => (
        <ClientRow key={k || "none"} title={k ? names.get(k)! : t("list.noClient")} href={k ? `/clients/${k}` : undefined} apps={apps} colors={colors} />
      ))}
      {creating && <NewAppDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

