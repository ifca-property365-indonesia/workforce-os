"use client";

import Link from "@/lib/nav";
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUpRight, PlayCircle } from "lucide-react";
import type { TaskStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Avatar, PageHeader, StatusBadge } from "@/components/layout/common";
import { WeeklySpendChart } from "@/components/inspector/weekly-spend";
import { LimitsCard } from "@/components/inspector/limits-card";
import { IncidentsCard } from "@/components/inspector/incidents-card";
import { PendingApprovalsList, usePendingApprovals } from "@/components/approvals/pending-list";
import { OfficeFacade, useBotMoods } from "@/components/office/employee-sign";
import { useOffice } from "@/components/office/use-office";
import { api } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useFormat } from "@/lib/use-format";
import { useEmployees } from "@/lib/hooks";
import { cn } from "@/lib/utils";

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

/** The street at the top of the dashboard: every employee's sign, and one line saying who is doing what. */
function OfficeStreet() {
  const t = useTranslations("dashboard");
  const to = useTranslations("office");
  const office = useOffice(to("generalRoom"));
  const { version, people, activityOf, loading } = office;
  const counts = useMemo(() => {
    void version;
    const c = { total: 0, working: 0, waiting: 0, idle: 0 };
    const now = Date.now();
    for (const p of people.current.values()) {
      const a = activityOf(p, now);
      c.total++;
      if (a === "waiting") c.waiting++;
      else if (a === "idle" || a === "paused") c.idle++;
      else c.working++;
    }
    return c;
  }, [version, people, activityOf]);
  return (
    <section aria-labelledby="office-street" className="rounded-2xl border bg-card px-4 pt-4 sm:px-5 sm:pt-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id="office-street" className="font-display text-[1.9rem]">
            {t("office.title")}
          </h2>
          {counts.total > 0 && <p className="mt-1 text-sm text-muted-foreground">{to("summary", counts)}</p>}
        </div>
        <Link href="/office" className="inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground">
          {t("office.open")} <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      </div>
      {!loading && counts.total === 0 ? <p className="pb-5 text-sm text-muted-foreground">{t("office.empty")}</p> : <OfficeFacade size="lg" />}
    </section>
  );
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const ts = useTranslations("status");
  const f = useFormat();
  const pct = (n: number | null) => (n == null ? "—" : new Intl.NumberFormat(f.locale, { style: "percent" }).format(n));
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dash>("/api/dashboard"), refetchInterval: 30_000 });
  const { data: emps } = useEmployees();
  const moods = useBotMoods();
  const { data: pending } = usePendingApprovals();
  const demo = useMutation({
    mutationFn: () => api.post("/api/demo"),
    onSuccess: () => toast.success(t("demoStarted")),
    onError: (e) => toast.error((e as Error).message),
  });
  const budgetPct = data ? Math.min(100, (data.spendThisMonth / Math.max(1, data.monthlyBudget)) * 100) : 0;
  const numbers = [
    { label: t("delivered"), value: data?.delivered30d ?? "…", hint: t("deliveredHint") },
    { label: t("costPerTask"), value: data ? f.credits(data.costPerCompletedTask) : "…", hint: data ? `≈ ${f.usd(data.costPerCompletedTask)}` : undefined },
    {
      label: t("approvalRate"),
      value: pct(data?.approvals.approvalRate ?? null),
      hint: data ? t("approvalHint", { decided: data.approvals.decided, rejection: pct(data.approvals.rejectionRate) }) : undefined,
    },
    {
      label: t("spendThisMonth"),
      value: data ? f.credits(data.spendThisMonth) : "…",
      hint: data && (
        <span className="block space-y-1.5">
          <Progress value={budgetPct} className="h-1.5" />
          <span className="block">{t("ofBudget", { budget: f.credits(data.monthlyBudget), pct: Math.round(budgetPct) })}</span>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="outline" onClick={() => demo.mutate()} disabled={demo.isPending} className="gap-1.5">
            <PlayCircle className="size-4" /> {t("runDemo")}
          </Button>
        }
      />

      <OfficeStreet />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] [&>*]:min-w-0">
        <section aria-labelledby="waiting" className="overflow-hidden rounded-2xl border bg-card">
          <div className={cn("flex items-center justify-between gap-3 px-5 py-3", pending?.length ? "approval-strip" : "border-b")}>
            <h2 id="waiting" className="font-display text-[1.45rem] tracking-[0.02em]">
              {t("waiting.title")}
            </h2>
            <span className="font-display text-[2rem]">{pending?.length ?? "…"}</span>
          </div>
          <div className="p-3">
            <PendingApprovalsList approvals={pending} limit={5} empty={t("waiting.empty")} />
            {!!pending?.length && (
              <Button asChild variant="outline" size="sm" className="ml-2 mt-2">
                <Link href="/approvals">{t("waiting.all")}</Link>
              </Button>
            )}
          </div>
        </section>
        <IncidentsCard />
      </div>

      <section aria-label={t("numbers")} className="grid grid-cols-2 overflow-hidden rounded-2xl border bg-card xl:grid-cols-4">
        {numbers.map((n, i) => (
          <div key={n.label} className={cn("min-w-0 p-4 sm:p-5", i % 2 === 1 && "border-l", i >= 2 && "border-t xl:border-t-0", i === 2 && "xl:border-l")}>
            <div className="text-sm font-medium text-muted-foreground">{n.label}</div>
            <div className="font-display mt-2 truncate text-[2.1rem] tabular-nums sm:text-[2.6rem]">{n.value}</div>
            {n.hint && <div className="mt-1 text-xs text-muted-foreground">{n.hint}</div>}
          </div>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
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
          <CardContent className="space-y-1">
            {(["QUEUED", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED"] as TaskStatus[]).map((s) => (
              <Link key={s} href={`/tasks?status=${s}`} className="flex min-h-10 items-center justify-between rounded-lg px-2 hover:bg-secondary/70">
                <StatusBadge status={s} />
                <span className="font-display text-[1.5rem] tabular-nums">{data?.statusCounts[s] ?? 0}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <LimitsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("yourEmployees")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {emps
            ?.filter((e) => e.status !== "ARCHIVED")
            .map((e) => (
              <Link key={e.id} href={`/employees/${e.id}`} className="flex items-center gap-3 rounded-xl border p-3 hover:bg-secondary/60">
                <Avatar id={e.id} mood={moods.get(e.id)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{e.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{e.role}</div>
                </div>
                <div className="text-right text-xs">
                  <div className="tabular-nums">
                    {f.credits(e.spentToday)} / {f.credits(e.dailyBudget)}
                  </div>
                  <div className={e.status === "ACTIVE" ? "text-success" : "text-warning"}>{ts(`employee.${e.status}`)}</div>
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
