"use client";

import { useSearchParams } from "@/lib/nav";
import { Suspense, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { ApprovalCard, DecisionItemCard, type Approval } from "@/components/approvals";
import { api } from "@/lib/api";
import { useInbox } from "@/lib/hooks";

function Inbox() {
  const sp = useSearchParams();
  const focus = sp.get("focus");
  const t = useTranslations("approvals");
  const [tab, setTab] = useState("PENDING");
  const { data: res } = useQuery({
    queryKey: ["approvals", tab],
    queryFn: () => api.get<{ approvals: Approval[]; waiting?: number }>(`/api/approvals${tab === "ALL" ? "" : `?status=${tab}`}`),
  });
  const items = res?.approvals;
  const waiting = res?.waiting ?? 0;
  // everything else that waits for a person (incidents, proposed tasks, paused employees, unmerged work)
  const { data: inbox } = useInbox();
  const others = tab === "PENDING" ? (inbox?.items ?? []) : [];
  useEffect(() => {
    if (!focus || !items) return;
    // a link to a decided approval (a task's preview, an app's release) finds it under All
    if (tab === "PENDING" && !items.some((a) => a.id === focus) && !inbox?.items.some((x) => x.id === focus)) setTab("ALL");
    else document.getElementById(focus)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, items, tab, inbox]);
  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <Tabs value={tab} onValueChange={setTab} className="mb-4">
        <TabsList>
          <TabsTrigger value="PENDING">{t("tabs.pending")}</TabsTrigger>
          <TabsTrigger value="EXECUTED,EXECUTING,APPROVED">{t("tabs.approved")}</TabsTrigger>
          <TabsTrigger value="REJECTED,EXPIRED">{t("tabs.rejected")}</TabsTrigger>
          <TabsTrigger value="ALL">{t("tabs.all")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "PENDING" && waiting > 0 && <p className="mb-4 text-sm text-muted-foreground">{t("waitingForRun", { count: waiting })}</p>}
      {!items?.length && !others.length && <EmptyState icon={<ShieldCheck className="size-8" />} title={tab === "PENDING" ? t("empty.pendingTitle") : t("empty.title")} description={t("empty.description")} />}
      {!!items?.length && !!others.length && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("inbox.approvalsHeading", { count: items.length })}</h2>}
      <div className="space-y-4">
        {items?.map((a) => (
          <ApprovalCard key={a.id} a={a} focused={a.id === focus} />
        ))}
      </div>
      {!!others.length && (
        <section className={items?.length ? "mt-6" : undefined} aria-labelledby="inbox-others">
          <h2 id="inbox-others" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("inbox.othersHeading", { count: others.length })}
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {others.map((x) => (
              <DecisionItemCard key={`${x.kind}:${x.id}`} item={x} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
