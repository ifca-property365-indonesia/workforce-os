"use client";

import Link from "@/lib/nav";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Building2, Plus, Search } from "lucide-react";
import { CLIENT_STATUSES, type ClientStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { NewClientDialog } from "@/components/clients/new-client-dialog";
import { ClientCode, ClientStatusBadge, HealthSign, useClientRights, worstHealth } from "@/components/clients/shared";
import { useClients, type Client } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

/** the person to call about a client: the project contact, else the first one listed */
function mainContact(c: Client) {
  return c.contacts.find((x) => x.role === "project") ?? c.contacts[0] ?? null;
}

function Metric({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-display text-base break-words tabular-nums sm:text-xl", tone)}>{children}</div>
    </div>
  );
}

function ClientCard({ c }: { c: Client }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const worst = worstHealth(c.projects);
  const contact = mainContact(c);
  return (
    <Link href={`/clients/${c.id}`} className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className={cn("h-full transition-shadow group-hover:shadow-md", c.status === "inactive" && "opacity-75")}>
        <CardContent className="flex h-full flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ClientCode code={c.code} />
                <div className="font-display truncate text-[1.65rem]">{c.name}</div>
              </div>
              {(c.industry || c.legalName) && <div className="truncate text-xs text-muted-foreground">{[c.industry, c.legalName].filter(Boolean).join(" · ")}</div>}
            </div>
            <ClientStatusBadge status={c.status} className="mt-1" />
          </div>
          <div className="grid grid-cols-3 gap-3 border-y py-3">
            <Metric label={t("list.projects")}>
              <span className="flex items-center gap-1.5">
                {c.projects.length}
                {worst && worst !== "done" && <HealthSign health={worst} />}
              </span>
            </Metric>
            <Metric label={t("list.monthly")}>{c.recurringMonthly ? f.money(c.recurringMonthly, c.currency) : "—"}</Metric>
            <Metric label={t("list.outstanding")} tone={c.overdue ? "text-destructive" : undefined}>
              {c.outstanding ? f.money(c.outstanding, c.currency) : "—"}
            </Metric>
          </div>
          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {contact ? (
                <>
                  <span className="font-medium text-foreground">{contact.name || contact.email}</span>
                  {contact.name && contact.email && ` · ${contact.email}`}
                </>
              ) : (
                c.email || t("noEmail")
              )}
            </span>
            {c.overdue > 0 && <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-destructive">{t("list.overdue", { count: c.overdue })}</span>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function ClientsPage() {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const { data, isLoading } = useClients();
  const { canEdit } = useClientRights();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<ClientStatus | "">("");
  const needle = q.trim().toLowerCase();
  const shown = (data ?? []).filter(
    (c) =>
      (!status || c.status === status) &&
      (!needle || [c.name, c.code, c.industry, c.legalName, c.email, ...c.contacts.flatMap((x) => [x.name, x.email])].some((s) => s.toLowerCase().includes(needle))),
  );
  const count = (s: ClientStatus) => (data ?? []).filter((c) => c.status === s).length;
  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canEdit && (
            <Button onClick={() => setCreating(true)} className="gap-1.5">
              <Plus className="size-4" /> {t("newClient")}
            </Button>
          )
        }
      />
      {!!data?.length && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("list.search")} aria-label={tc("search")} className="pl-8" />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={tc("status")}>
            {(["", ...CLIENT_STATUSES] as const).map((s) => (
              <button
                key={s || "all"}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", status === s ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              >
                {s ? t(`status.${s}`) : t("list.all")}
                <span className="ml-1 tabular-nums opacity-70">{s ? count(s) : data.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!isLoading && !data?.length && <EmptyState icon={<Building2 className="size-8" />} title={t("empty")} description={t("emptyHelp")} />}
      {!!data?.length && !shown.length && <EmptyState icon={<Search className="size-7" />} title={t("list.noMatch")} />}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) => (
          <ClientCard key={c.id} c={c} />
        ))}
      </div>
      {creating && <NewClientDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
