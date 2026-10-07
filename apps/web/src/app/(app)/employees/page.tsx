"use client";

import Link from "next/link";
import { Plus, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AutonomyBadge, EmptyState, PageHeader } from "@/components/layout/common";
import { useEmployees, useTemplates } from "@/lib/hooks";
import { credits } from "@/lib/format";

export default function EmployeesPage() {
  const { data: emps } = useEmployees();
  const { data: tpl } = useTemplates();
  const active = emps?.filter((e) => e.status !== "ARCHIVED") ?? [];
  return (
    <div>
      <PageHeader
        title="AI employees"
        description="Each employee has a role, memory, scoped tools and an explicit autonomy level."
        actions={
          <Button asChild className="gap-1.5">
            <Link href="/employees/hire">
              <Plus className="size-4" /> Hire employee
            </Link>
          </Button>
        }
      />
      {active.length === 0 ? (
        <EmptyState icon={<Bot className="size-8" />} title="No employees yet" description="Pick a role template from the marketplace below to hire your first AI employee." />
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
                      <span>{e.toolPermissions.filter((p) => p.enabled).length} tools · {e.model}</span>
                      <span className={e.status === "ACTIVE" ? "text-emerald-600" : "text-amber-600"}>{e.status.replace("_", " ").toLowerCase()}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Today: {credits(e.spentToday)} / {credits(e.dailyBudget)} credits
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">Marketplace</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tpl?.templates.map((t) => (
          <Card key={t.key} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col gap-2 p-4">
              <div className="flex items-center gap-2">
                <Avatar emoji={t.avatar} />
                <div>
                  <div className="font-semibold">{t.role}</div>
                  <div className="text-xs text-muted-foreground">Default autonomy {t.autonomyLevel}</div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{t.tagline}</p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {t.exampleTasks.slice(0, 2).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <Button asChild variant="secondary" size="sm" className="mt-auto">
                <Link href={`/employees/hire?template=${t.key}`}>Hire a {t.role}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
