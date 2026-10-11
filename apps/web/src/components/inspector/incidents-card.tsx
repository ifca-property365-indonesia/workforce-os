"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AlertOctagon, CheckCircle2 } from "lucide-react";
import type { IncidentKind, IncidentStatus } from "@wfos/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

export interface IncidentRow {
  id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  summary: string;
  routineId: string | null;
  createdAt: string;
  task: { id: string; title: string; status: string } | null;
  employee: { id: string; name: string; avatar: string } | null;
  handler: { id: string; name: string; avatar: string } | null;
}

const STATUS_TONE: Record<IncidentStatus, string> = {
  open: "bg-warning/15 text-warning",
  handling: "bg-[var(--sign-biru)]/15 text-[var(--sign-biru)] dark:text-[color-mix(in_srgb,var(--sign-biru)_60%,white)]",
  escalated: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  resolved: "bg-success/15 text-success",
};

/** Runs that failed, stalled, looped or could not start, and who is on them: the team lead, or you. */
export function IncidentsCard() {
  const t = useTranslations("dashboard");
  const f = useFormat();
  // task.updated invalidates "incidents" (incidents open and resolve together with their tasks)
  const { data } = useQuery({
    queryKey: ["incidents"],
    queryFn: () => api.get<{ incidents: IncidentRow[]; resolved7d: number }>("/api/incidents"),
    refetchInterval: 60_000,
  });
  const rows = data?.incidents ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertOctagon className="size-4" /> {t("incidents.title")}
          {rows.length > 0 && <span className="rounded-full bg-destructive/10 px-2 text-xs font-medium tabular-nums text-destructive">{rows.length}</span>}
        </CardTitle>
        <CardDescription>{t("incidents.resolved7d", { count: data?.resolved7d ?? 0 })}</CardDescription>
      </CardHeader>
      <CardContent>
        {data && !rows.length && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" /> {t("incidents.empty")}
          </p>
        )}
        <ul className="divide-y">
          {rows.slice(0, 8).map((i) => {
            // escalated / muted incidents wait for a person even when a lead had a turn before
            const lead = i.status === "escalated" || i.status === "muted" ? null : i.handler;
            return (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="font-medium">{t(`incidents.kind.${i.kind}`)}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[11px]", STATUS_TONE[i.status])}>{t(`incidents.status.${i.status}`)}</span>
              {i.task ? (
                <Link href={`/tasks/${i.task.id}`} className="order-first min-w-0 basis-full break-words sm:order-none sm:basis-0 sm:flex-1 sm:truncate text-primary hover:underline">
                  {i.task.title}
                </Link>
              ) : i.routineId ? (
                <Link href="/routines" className="order-first min-w-0 basis-full break-words sm:order-none sm:basis-0 sm:flex-1 sm:truncate text-primary hover:underline">
                  {i.summary || t("incidents.routine")}
                </Link>
              ) : (
                <span className="order-first min-w-0 basis-full break-words sm:order-none sm:basis-0 sm:flex-1 sm:truncate text-muted-foreground">{i.summary || t("incidents.noTask")}</span>
              )}
              <span className={cn("text-xs", lead ? "text-muted-foreground" : "font-medium text-destructive")}>
                {lead ? t("incidents.handledBy", { name: lead.name }) : t("incidents.needsYou")}
              </span>
              <span className="w-20 text-right text-xs text-muted-foreground">{f.ago(i.createdAt)}</span>
            </li>
            );
          })}
        </ul>
        {rows.length > 8 && <p className="mt-2 text-xs text-muted-foreground">{t("incidents.more", { count: rows.length - 8 })}</p>}
      </CardContent>
    </Card>
  );
}
