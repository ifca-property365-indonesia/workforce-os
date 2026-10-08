"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Coins, PlayCircle, ShieldCheck, Wallet } from "lucide-react";
import type { TaskStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Avatar, PageHeader, Stat, StatusBadge } from "@/components/layout/common";
import { WeeklySpendChart } from "@/components/inspector/weekly-spend";
import { LimitsCard } from "@/components/inspector/limits-card";
import { api } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useFormat } from "@/lib/use-format";
import { useEmployees } from "@/lib/hooks";

interface Dash {
  delivered30d: number;
  costPerCompletedTask: number;
  spendThisMonth: number;
  monthlyBudget: number;
  statusCounts: Partial<Record<TaskStatus, number>>;
  approvals: { pending: number; decided: number; approvalRate: number | null; rejectionRate: number | null };
  weeklySpend: { week: string; employeeId: string | null; credits: number }[];
  employees: { id: string; name: string; avatar: string; status: string }[];
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const ts = useTranslations("status");
  const f = useFormat();
  const pct = (n: number | null) => (n == null ? "—" : new Intl.NumberFormat(f.locale, { style: "percent" }).format(n));
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dash>("/api/dashboard"), refetchInterval: 30_000 });
  const { data: emps } = useEmployees();
  const demo = useMutation({
    mutationFn: () => api.post("/api/demo"),
    onSuccess: () => toast.success(t("demoStarted")),
    onError: (e) => toast.error((e as Error).message),
  });
  const budgetPct = data ? Math.min(100, (data.spendThisMonth / Math.max(1, data.monthlyBudget)) * 100) : 0;

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="outline" onClick={() => demo.mutate()} disabled={demo.isPending} className="gap-1.5">
            <PlayCircle className="size-4" /> {t("runDemo")}
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("delivered")} value={data?.delivered30d ?? "…"} hint={t("deliveredHint")} icon={<CheckCircle2 className="size-4" />} />
        <Stat label={t("costPerTask")} value={data ? f.credits(data.costPerCompletedTask) : "…"} hint={data ? `≈ ${f.usd(data.costPerCompletedTask)}` : undefined} icon={<Coins className="size-4" />} />
        <Stat
          label={t("approvalRate")}
          value={pct(data?.approvals.approvalRate ?? null)}
          hint={data ? t("approvalHint", { decided: data.approvals.decided, rejection: pct(data.approvals.rejectionRate) }) : undefined}
          icon={<ShieldCheck className="size-4" />}
        />
        <Stat
          label={t("spendThisMonth")}
          value={data ? f.credits(data.spendThisMonth) : "…"}
          hint={
            data && (
              <div className="space-y-1">
                <Progress value={budgetPct} className="h-1.5" />
                <span>{t("ofBudget", { budget: f.credits(data.monthlyBudget), pct: Math.round(budgetPct) })}</span>
              </div>
            )
          }
          icon={<Wallet className="size-4" />}
        />
      </div>

      <div className="mt-6">
        <LimitsCard />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t("weeklySpend")}</CardTitle>
            <CardDescription>{t("weeklySpendHint")}</CardDescription>
          </CardHeader>
          <CardContent>{data && <WeeklySpendChart rows={data.weeklySpend} employees={data.employees} />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("wip")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(["QUEUED", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED"] as TaskStatus[]).map((s) => (
              <Link key={s} href={`/tasks?status=${s}`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent">
                <StatusBadge status={s} />
                <span className="text-sm font-medium tabular-nums">{data?.statusCounts[s] ?? 0}</span>
              </Link>
            ))}
            {!!data?.approvals.pending && (
              <Button asChild className="mt-2 w-full" variant="secondary">
                <Link href="/approvals">{t("reviewPending", { count: data.approvals.pending })}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("yourEmployees")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {emps
            ?.filter((e) => e.status !== "ARCHIVED")
            .map((e) => (
              <Link key={e.id} href={`/employees/${e.id}`} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent">
                <Avatar emoji={e.avatar} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{e.role}</div>
                </div>
                <div className="text-right text-xs">
                  <div className="tabular-nums">
                    {f.credits(e.spentToday)} / {f.credits(e.dailyBudget)}
                  </div>
                  <div className={e.status === "ACTIVE" ? "text-emerald-600" : "text-amber-600"}>{ts(`employee.${e.status}`)}</div>
                </div>
              </Link>
            ))}
          {!emps?.length && (
            <p className="text-sm text-muted-foreground">
              {t.rich("noEmployees", {
                link: (c) => (
                  <Link href="/employees/hire" className="text-primary underline">
                    {c}
                  </Link>
                ),
              })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
