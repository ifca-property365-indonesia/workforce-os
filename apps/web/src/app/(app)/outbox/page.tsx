"use client";

import Link, { useRouter, useSearchParams } from "@/lib/nav";
import { Suspense, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText, Mail, PauseCircle, Send } from "lucide-react";
import { hasRole } from "@wfos/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Avatar, EmptyState, PageHeader } from "@/components/layout/common";
import { usePendingApprovals } from "@/components/approvals/pending-list";
import { OutboxDetail } from "@/components/outbox/outbox-detail";
import { OutboxStatusBadge, recipientSummary, unknownCount } from "@/components/outbox/parts";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { OutboxItem, OutboxStats } from "@/lib/outbox";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

const TABS = ["all", "pending_approval", "sent", "failed", "rejected,expired"] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  all: "all",
  pending_approval: "pending",
  sent: "sent",
  failed: "failed",
  "rejected,expired": "refused",
};
const sel = "h-9 rounded-md border bg-background px-2 text-sm";

function Numbers({ stats }: { stats: OutboxStats | undefined }) {
  const t = useTranslations("outbox");
  const cells = [
    { key: "sent", label: t("stats.sentToday"), value: stats ? t("stats.ofLimit", { count: stats.sentToday, limit: stats.dailyLimit }) : "…", tone: "" },
    { key: "failed", label: t("stats.failedToday"), value: stats?.failedToday ?? "…", tone: stats?.failedToday ? "text-destructive" : "" },
    { key: "pending", label: t("stats.pending"), value: stats?.pending ?? "…", tone: "" },
  ];
  return (
    <section aria-label={t("stats.label")} className="grid grid-cols-3 overflow-hidden rounded-2xl border bg-card">
      {cells.map((c, i) => (
        <div key={c.key} className={cn("min-w-0 p-3 sm:p-4", i > 0 && "border-l")}>
          <div className="truncate text-xs font-medium text-muted-foreground sm:text-sm">{c.label}</div>
          <div className={cn("font-display mt-1.5 truncate text-[1.7rem] tabular-nums sm:text-[2.2rem]", c.tone)}>{c.value}</div>
        </div>
      ))}
    </section>
  );
}

function Row({ item, onOpen, active }: { item: OutboxItem; onOpen: () => void; active: boolean }) {
  const t = useTranslations("outbox");
  const f = useFormat();
  const { first, more } = recipientSummary(item);
  const unknown = unknownCount(item);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none sm:px-4",
          item.status === "pending_approval" && "bg-approval/[0.07]",
          active && "bg-secondary",
        )}
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
          {item.kind === "invoice" ? <FileText className="size-4" /> : <Mail className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex items-start gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug">{item.subject || t("detail.noSubject")}</span>
            <OutboxStatusBadge status={item.status} className="mt-px" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">{t("list.to")}</span>
            <span className="min-w-0 truncate font-medium text-foreground/80">{first || "—"}</span>
            {more > 0 && <span className="shrink-0">{t("list.more", { count: more })}</span>}
            {unknown > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-destructive" title={t("list.unknown", { count: unknown })}>
                <AlertTriangle className="size-3" aria-hidden />
                <span className="sr-only sm:not-sr-only">{t("list.unknown", { count: unknown })}</span>
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {item.employee && (
              <span className="inline-flex items-center gap-1">
                <Avatar id={item.employee.id} size="sm" className="size-4 p-0" /> {item.employee.name}
              </span>
            )}
            {item.client && <span className="rounded bg-muted px-1">{item.client.name}</span>}
            <time dateTime={item.createdAt} title={f.dateTime(item.createdAt)}>
              {f.ago(item.createdAt)}
            </time>
          </span>
        </span>
      </button>
    </li>
  );
}

function Outbox() {
  const t = useTranslations("outbox");
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const admin = !!me && hasRole(me.role, "ADMIN");
  const tab = (TABS as readonly string[]).includes(sp.get("status") ?? "") ? (sp.get("status") as (typeof TABS)[number]) : "all";
  const kind = sp.get("kind") === "email" || sp.get("kind") === "invoice" ? sp.get("kind")! : "";
  const focus = sp.get("focus");
  const qs = new URLSearchParams({ ...(tab !== "all" && { status: tab }), ...(kind && { kind }) }).toString();
  const { data, isLoading } = useQuery({
    queryKey: ["outbox", "list", qs],
    queryFn: () => api.get<{ items: OutboxItem[]; stats: OutboxStats }>(`/api/outbox?${qs}`),
  });
  const { data: focused, isError: focusMissing } = useQuery({
    queryKey: ["outbox", "item", focus],
    queryFn: () => api.get<{ item: OutboxItem }>(`/api/outbox/${encodeURIComponent(focus!)}`).then((r) => r.item),
    enabled: !!focus,
    // shown straight from the list while it loads
    placeholderData: () => data?.items.find((i) => i.id === focus),
  });
  // a decision made in the detail (or anywhere) changes what the outbox shows, even without the live stream
  const { dataUpdatedAt } = usePendingApprovals();
  const seen = useRef(0);
  useEffect(() => {
    if (seen.current && dataUpdatedAt !== seen.current) void qc.invalidateQueries({ queryKey: ["outbox"] });
    seen.current = dataUpdatedAt;
  }, [dataUpdatedAt, qc]);

  const setParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v);
    else n.delete(k);
    const s = n.toString();
    router.replace(s ? `/outbox?${s}` : "/outbox");
  };
  const stats = data?.stats;

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
      {stats?.paused && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
          <PauseCircle className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 font-medium">{t("paused")}</span>
          {admin && (
            <Link href="/settings?tab=email" className="font-semibold underline-offset-2 hover:underline">
              {t("openSettings")}
            </Link>
          )}
        </div>
      )}
      <Numbers stats={stats} />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => setParam("status", v === "all" ? null : v)} className="min-w-0 max-w-full overflow-x-auto">
          <TabsList>
            {TABS.map((x) => (
              <TabsTrigger key={x} value={x}>
                {t(`tabs.${TAB_LABEL[x]}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <select className={sel} value={kind} onChange={(e) => setParam("kind", e.target.value || null)} aria-label={t("filters.kind")}>
          <option value="">{t("filters.allKinds")}</option>
          <option value="email">{t("kind.email")}</option>
          <option value="invoice">{t("kind.invoice")}</option>
        </select>
      </div>
      {!isLoading && !data?.items.length ? (
        <EmptyState icon={<Send className="size-8" />} title={tab === "all" && !kind ? t("empty.title") : t("empty.filtered")} description={t("empty.description")} />
      ) : (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
          {data?.items.map((item) => (
            <Row key={item.id} item={item} active={item.id === focus} onOpen={() => setParam("focus", item.id)} />
          ))}
        </ul>
      )}
      <Sheet open={!!focus} onOpenChange={(o) => !o && setParam("focus", null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader className="border-b pr-12">
            <SheetTitle className="break-words text-base leading-snug">{focused ? focused.subject || t("detail.noSubject") : t("detail.title")}</SheetTitle>
            <SheetDescription>{focused?.kind === "invoice" ? t("detail.invoiceDescription") : t("detail.description")}</SheetDescription>
          </SheetHeader>
          <div className="p-4">{focused ? <OutboxDetail item={focused} admin={admin} /> : <p className="text-sm text-muted-foreground">{focusMissing ? t("detail.notFound") : t("detail.loading")}</p>}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default function OutboxPage() {
  return (
    <Suspense>
      <Outbox />
    </Suspense>
  );
}
