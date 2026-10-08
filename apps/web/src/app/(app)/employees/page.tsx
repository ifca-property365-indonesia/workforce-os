"use client";

import Link from "next/link";
import { Plus, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AutonomyBadge, EmptyState, PageHeader } from "@/components/layout/common";
import { useEmployees, useTemplates } from "@/lib/hooks";
import { useTranslations } from "next-intl";
import { useFormat } from "@/lib/use-format";

export default function EmployeesPage() {
  const t = useTranslations("employees");
  const ts = useTranslations("status");
  const f = useFormat();
  const { data: emps } = useEmployees();
  const { data: tpl } = useTemplates();
  const active = emps?.filter((e) => e.status !== "ARCHIVED") ?? [];
  return (
    <div>
      <PageHeader
        title={t("list.title")}
        description={t("list.description")}
        actions={
          <Button asChild className="gap-1.5">
            <Link href="/employees/hire">
              <Plus className="size-4" /> {t("list.hire")}
            </Link>
          </Button>
        }
      />
      {active.length === 0 ? (
        <EmptyState icon={<Bot className="size-8" />} title={t("list.emptyTitle")} description={t("list.emptyDescription")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((e) => (
            <Link key={e.id} href={`/employees/${e.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="flex gap-3 p-4">
                  <Avatar emoji={e.avatar} size="lg" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold">{e.name}</span>
                      <AutonomyBadge level={e.autonomyLevel} />
                    </div>
                    <div className="text-sm text-muted-foreground">{e.role}</div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {t("list.toolsCount", { count: e.toolPermissions.filter((p) => p.enabled).length })} · {e.model}
                      </span>
                      <span className={e.status === "ACTIVE" ? "text-emerald-600" : "text-amber-600"}>{ts(`employee.${e.status}`)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("list.spentToday", { spent: f.credits(e.spentToday), budget: f.credits(e.dailyBudget) })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("list.marketplace")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tpl?.templates.map((tp) => (
          <Card key={tp.key} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col gap-2 p-4">
              <div className="flex items-center gap-2">
                <Avatar emoji={tp.avatar} />
                <div>
                  <div className="font-semibold">{tp.role}</div>
                  <div className="text-xs text-muted-foreground">{t("list.defaultAutonomy", { level: ts(`autonomy.${tp.autonomyLevel}`) })}</div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{tp.tagline}</p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {tp.exampleTasks.slice(0, 2).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <Button asChild variant="secondary" size="sm" className="mt-auto">
                <Link href={`/employees/hire?template=${tp.key}`}>{t("list.hireRole", { role: tp.role })}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
