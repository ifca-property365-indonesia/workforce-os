"use client";

import Link from "@/lib/nav";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AppWindow, FolderKanban, ListTodo, Mail, ReceiptText, UsersRound } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Avatar, StatusBadge } from "@/components/layout/common";
import { useApps } from "@/components/apps/shared";
import { UptimeDot, useUptime } from "@/components/apps/uptime";
import type { AppDTO } from "@wfos/shared";
import { useEmployees, useTeams, type ClientDetail, type Team } from "@/lib/hooks";
import { divisionSignVars } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { HealthSign, InvoiceStatusBadge } from "./shared";

const EMAIL_TONE = { sending: "bg-muted text-muted-foreground", sent: "bg-success/15 text-success", failed: "bg-destructive/15 text-destructive" } as const;

function Panel({ title, icon, count, children, className, empty }: { title: string; icon: ReactNode; count?: number; children: ReactNode; className?: string; empty?: string | false }) {
  return (
    <section className={cn("min-w-0 rounded-2xl border bg-card p-4", className)}>
      <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground" aria-hidden>
          {icon}
        </span>
        {title}
        {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
      </h2>
      {empty ? <p className="text-sm text-muted-foreground">{empty}</p> : children}
    </section>
  );
}

function DivisionChip({ d }: { d: Team | undefined }) {
  if (!d) return null;
  return (
    <span className="sign inline-flex shrink-0 rounded-md px-1.5 text-[11px] font-semibold leading-5" data-state="lit" style={divisionSignVars(d.color, d.id)}>
      {d.name}
    </span>
  );
}

/** one app of the client: live status dot, address and 7-day uptime */
function AppLine({ app }: { app: AppDTO }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const live = app.live;
  const { data: up } = useUptime(app.id, 7, !!live);
  return (
    <li className="flex items-center gap-2 py-1.5 text-sm">
      <UptimeDot status={live?.uptimeStatus ?? "unknown"} />
      <Link href={`/apps/${app.id}`} className="min-w-0 truncate font-medium hover:underline">
        {app.name}
      </Link>
      {live ? (
        <a href={live.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-xs text-muted-foreground hover:underline">
          {live.domain}
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">{t("overview.previewOnly")}</span>
      )}
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{live && up?.pct.week != null ? t("overview.uptime", { pct: f.number(up.pct.week, 2) }) : "—"}</span>
    </li>
  );
}

/**
 * Everything about one client on one screen: projects with their health, next milestone and next step, the work in
 * progress, the client's apps with uptime, unpaid invoices, the latest emails and the contacts.
 */
export function ClientOverview({ data }: { data: ClientDetail }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const { data: divisions } = useTeams();
  const { data: emps } = useEmployees();
  const { data: apps } = useApps();
  const { client: c, projects, invoices, running, history } = data;
  const divisionOf = (id: string | null) => (id ? divisions?.find((d) => d.id === id) : undefined);
  const myApps = (apps ?? []).filter((a) => a.clientId === c.id);
  const unpaid = invoices.filter((i) => i.status === "sent");
  const emails = history.emails.slice(0, 5);
  const projectName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined);
  const order = { late: 0, at_risk: 1, on_track: 2, done: 3 } as const;
  const shown = [...projects].sort((a, b) => order[a.health] - order[b.health] || a.name.localeCompare(b.name));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title={t("overview.projects")} icon={<FolderKanban className="size-4" />} count={projects.length} className="lg:col-span-2" empty={!projects.length && t("project.empty")}>
        <ul className="divide-y">
          {shown.map((p) => (
            <li key={p.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <HealthSign health={p.health} title={p.reasons.map((r) => t(`health.reason.${r}`)).join(" · ")} />
                <span className="min-w-0 truncate font-semibold">{p.name}</span>
                <DivisionChip d={divisionOf(p.teamId)} />
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {p.deadline ? t("overview.deadline", { date: f.date(p.deadline) }) : t("overview.noDeadline")}
                </span>
              </div>
              <div className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                <div className="min-w-0">
                  <span className="text-muted-foreground">{t("project.nextMilestone")}: </span>
                  {p.nextMilestone || "—"}
                </div>
                <div className="min-w-0">
                  <span className="text-muted-foreground">{t("project.nextStep")}: </span>
                  {p.nextStep || "—"}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Progress value={p.progress} className="h-1.5 flex-1" aria-label={t("project.progress")} />
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{p.progress}%</span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid gap-4">
        <Panel title={t("overview.running")} icon={<ListTodo className="size-4" />} count={running.length} empty={!running.length && t("overview.noRunning")}>
          <ul className="space-y-1.5">
            {running.slice(0, 8).map((task) => {
              const who = task.assigneeId ? emps?.find((e) => e.id === task.assigneeId) : undefined;
              return (
                <li key={task.id} className="flex items-center gap-2 text-sm">
                  {who ? <Avatar id={who.id} size="sm" /> : <DivisionChip d={divisionOf(task.teamId)} />}
                  <Link href={`/tasks/${task.id}`} className="min-w-0 flex-1 truncate hover:underline" title={projectName(task.projectId)}>
                    {task.title}
                  </Link>
                  <StatusBadge status={task.status} />
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel title={t("overview.apps")} icon={<AppWindow className="size-4" />} count={myApps.length} empty={!myApps.length && t("overview.noApps")}>
          <ul className="divide-y">
            {myApps.map((a) => (
              <AppLine key={a.id} app={a} />
            ))}
          </ul>
        </Panel>
      </div>

      <Panel title={t("overview.unpaid")} icon={<ReceiptText className="size-4" />} count={unpaid.length} empty={!unpaid.length && t("overview.noUnpaid")}>
        <ul className="space-y-1.5">
          {unpaid.map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-sm">
              <span className="font-mono font-medium">{i.number}</span>
              <InvoiceStatusBadge status={i.status} overdue={i.overdue} />
              <span className="ml-auto tabular-nums">{f.money(i.total, i.currency)}</span>
            </li>
          ))}
        </ul>
        {unpaid.length > 0 && <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">{t("overview.unpaidTotal", { total: f.money(c.outstanding, c.currency) })}</p>}
      </Panel>

      <Panel title={t("overview.emails")} icon={<Mail className="size-4" />} empty={!emails.length && t("overview.noEmails")}>
        <ul className="space-y-1.5">
          {emails.map((m) => (
            <li key={m.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{m.subject || t("history.noSubject")}</span>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", EMAIL_TONE[m.status])} title={m.error ?? undefined}>
                  {t(`history.emailStatus.${m.status}`)}
                </span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {m.to.join(", ")} · {f.ago(m.sentAt ?? m.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={t("overview.contacts")} icon={<UsersRound className="size-4" />} count={c.contacts.length} empty={!c.contacts.length && t("contacts.empty")}>
        <ul className="space-y-1.5">
          {c.contacts.map((x, i) => (
            <li key={i} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate font-medium">{x.name || x.email}</span>
                <span className="shrink-0 rounded bg-secondary px-1.5 text-[11px] text-muted-foreground">{t(`contacts.role.${x.role}`)}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">{[x.email, x.phone].filter(Boolean).join(" · ")}</div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
