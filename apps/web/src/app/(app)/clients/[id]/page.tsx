"use client";

import Link from "@/lib/nav";
import { use, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Building2, ExternalLink, FileText, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/layout/common";
import { NewTaskDialog, type NewTaskPrefill } from "@/components/tasks/new-task-dialog";
import { ClientInfo } from "@/components/clients/client-info";
import { ClientContacts } from "@/components/clients/client-contacts";
import { ClientProjects } from "@/components/clients/client-projects";
import { RecurringBillings } from "@/components/clients/recurring-billing";
import { InvoiceLedger } from "@/components/clients/invoice-ledger";
import { ClientHistory } from "@/components/clients/client-history";
import { ClientOverview } from "@/components/clients/client-overview";
import { ClientCode, ClientStatusBadge, HealthSign, useClientRights, worstHealth } from "@/components/clients/shared";
import { useClient, useTeams } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

function Tile({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-display text-2xl break-words tabular-nums sm:text-[1.9rem]", tone)}>{value}</div>
      {note && <div className="truncate text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

export default function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("clients");
  const f = useFormat();
  const { data, isLoading, isError } = useClient(id);
  const { data: divisions } = useTeams();
  const { canEdit } = useClientRights();
  const [task, setTask] = useState<{ key: number; initial: NewTaskPrefill } | null>(null);
  const back = (
    <Link href="/clients" className="text-sm text-muted-foreground hover:text-foreground">
      ← {t("detail.back")}
    </Link>
  );
  if (isLoading) return back;
  if (isError || !data)
    return (
      <div className="space-y-4">
        {back}
        <EmptyState icon={<Building2 className="size-8" />} title={t("detail.notFound")} />
      </div>
    );
  const { client: c, projects, recurring, invoices, history } = data;
  const worst = worstHealth(projects);
  // invoices are Finance & Accounting's work: the quick action gives it to that division
  const finance = divisions?.find((d) => d.key === "finance" && d.leadId);
  const open = (initial: NewTaskPrefill) => setTask({ key: Date.now(), initial: { clientId: c.id, ...initial } });
  return (
    <div className="space-y-5">
      {back}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[2.6rem] text-balance">{c.name}</h1>
            <ClientCode code={c.code} className="text-sm" />
            <ClientStatusBadge status={c.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {[c.industry, c.legalName, c.email, c.currency].filter(Boolean).join(" · ")}
            {c.website && (
              <a href={/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                {c.website.replace(/^https?:\/\//i, "")} <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="gap-1.5" onClick={() => open({ title: t("quick.statusTitle", { name: c.name }), brief: t("quick.statusBrief", { name: c.name }) })}>
              <FileText className="size-4" /> {t("quick.status")}
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => open({ title: t("quick.invoiceTitle", { name: c.name }), brief: t("quick.invoiceBrief", { name: c.name }), assignee: finance ? `t:${finance.id}` : "" })}
            >
              <ReceiptText className="size-4" /> {t("quick.invoice")}
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("list.projects")} value={projects.length} note={worst && <HealthSign health={worst} />} />
        <Tile label={t("list.monthly")} value={c.recurringMonthly ? f.money(c.recurringMonthly, c.currency) : "—"} note={t("detail.beforeTax")} />
        <Tile label={t("list.outstanding")} value={c.outstanding ? f.money(c.outstanding, c.currency) : "—"} note={t("detail.unpaid")} />
        <Tile label={t("detail.overdue")} value={c.overdue} tone={c.overdue ? "text-destructive" : undefined} note={t("detail.overdueNote")} />
      </div>
      <Tabs defaultValue="overview">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-fit">
          <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
          <TabsTrigger value="info">{t("tabs.info")}</TabsTrigger>
          <TabsTrigger value="contacts">{t("tabs.contacts", { count: c.contacts.length })}</TabsTrigger>
          <TabsTrigger value="projects">{t("tabs.projects", { count: projects.length })}</TabsTrigger>
          <TabsTrigger value="recurring">{t("tabs.recurring", { count: recurring.length })}</TabsTrigger>
          <TabsTrigger value="invoices">{t("tabs.invoices", { count: invoices.length })}</TabsTrigger>
          <TabsTrigger value="history">{t("tabs.history")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <ClientOverview data={data} />
        </TabsContent>
        <TabsContent value="info" className="mt-4">
          <ClientInfo key={c.id} client={c} />
        </TabsContent>
        <TabsContent value="contacts" className="mt-4">
          <ClientContacts key={JSON.stringify(c.contacts)} clientId={c.id} contacts={c.contacts} />
        </TabsContent>
        <TabsContent value="projects" className="mt-4">
          <ClientProjects clientId={c.id} projects={projects} currency={c.currency} />
        </TabsContent>
        <TabsContent value="recurring" className="mt-4">
          <RecurringBillings clientId={c.id} currency={c.currency} rows={recurring} projects={projects} />
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <InvoiceLedger clientId={c.id} invoices={invoices} />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ClientHistory history={history} />
        </TabsContent>
      </Tabs>
      {task && <NewTaskDialog key={task.key} open onOpenChange={(o) => !o && setTask(null)} initial={task.initial} />}
    </div>
  );
}
