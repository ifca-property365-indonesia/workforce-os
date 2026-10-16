"use client";

import { useSearchParams } from "@/lib/nav";
import { Suspense, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { ApprovalCard, type Approval } from "@/components/approvals";
import { api } from "@/lib/api";

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
  useEffect(() => {
    if (!focus || !items) return;
    // a link to a decided approval (a task's preview, an app's release) finds it under All
    if (tab === "PENDING" && !items.some((a) => a.id === focus)) setTab("ALL");
    else document.getElementById(focus)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, items, tab]);
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
      {!items?.length && <EmptyState icon={<ShieldCheck className="size-8" />} title={tab === "PENDING" ? t("empty.pendingTitle") : t("empty.title")} description={t("empty.description")} />}
      <div className="space-y-4">
        {items?.map((a) => (
          <ApprovalCard key={a.id} a={a} focused={a.id === focus} />
        ))}
      </div>
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
