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
  const { data } = useQuery({
    queryKey: ["approvals", tab],
    queryFn: () => api.get<{ approvals: Approval[] }>(`/api/approvals${tab === "ALL" ? "" : `?status=${tab}`}`).then((r) => r.approvals),
  });
  useEffect(() => {
    if (focus && data) document.getElementById(focus)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, data]);
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
      {!data?.length && <EmptyState icon={<ShieldCheck className="size-8" />} title={tab === "PENDING" ? t("empty.pendingTitle") : t("empty.title")} description={t("empty.description")} />}
      <div className="space-y-4">
        {data?.map((a) => (
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
