"use client";

import Link from "@/lib/nav";
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { FolderKanban, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/layout/common";
import { api } from "@/lib/api";
import type { ClientProject } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { HEALTH_TONE, HealthBadge, invalidateClient, useClientRights } from "./shared";

/** Per-client health summary: how many projects are late / at risk / on track. */
export function HealthSummary({ projects }: { projects: ClientProject[] }) {
  const t = useTranslations("clients");
  const counts = (["late", "at_risk", "on_track"] as const).map((h) => [h, projects.filter((p) => p.health === h).length] as const).filter(([, n]) => n);
  if (!counts.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {counts.map(([h, n]) => (
        <span key={h} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${HEALTH_TONE[h]}`}>
          {t("health.count", { count: n, health: t(`health.${h}`) })}
        </span>
      ))}
    </div>
  );
}

function ProjectRow({ p, currency }: { p: ClientProject; currency: string }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const qc = useQueryClient();
  const { canEdit, admin } = useClientRights();
  const del = useMutation({ mutationFn: () => api.del(`/api/projects/${p.id}`), onSuccess: () => invalidateClient(qc, p.clientId) });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/projects/${p.id}`, body),
    onSuccess: () => invalidateClient(qc, p.clientId),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {p.name} <span className="ml-1 rounded bg-muted px-1.5 text-[11px]">{t.has(`project.status.${p.status}`) ? t(`project.status.${p.status}`) : p.status}</span>
        </div>
        {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
        <div className="text-xs text-muted-foreground">{t("project.rate", { rate: f.money(p.hourlyRate, currency) })}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <HealthBadge health={p.health} title={p.reasons.map((r) => t(`health.reason.${r}`)).join(" · ")} />
          <label className="flex items-center gap-1 text-muted-foreground">
            {t("project.deadline")}
            <input
              type="date"
              className="rounded border bg-background px-1 py-0.5"
              defaultValue={p.deadline ?? ""}
              disabled={!canEdit}
              onChange={(e) => save.mutate({ deadline: e.target.value || null })}
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            {t("project.progress")}
            <input
              type="number"
              min={0}
              max={100}
              className="w-14 rounded border bg-background px-1 py-0.5"
              defaultValue={p.progress}
              disabled={!canEdit}
              onBlur={(e) => Number(e.target.value) !== p.progress && save.mutate({ progress: Math.max(0, Math.min(100, Number(e.target.value))) })}
            />
            %
          </label>
          <span className="text-muted-foreground">
            {p.daysToDeadline !== null && p.health !== "done" && (p.daysToDeadline < 0 ? t("health.overdue", { count: -p.daysToDeadline }) : t("health.dueIn", { count: p.daysToDeadline }))}
            {p.daysToDeadline !== null && p.health !== "done" && " · "}
            {t("health.lastActivity", { when: f.ago(p.lastActivityAt) })}
          </span>
        </div>
        <Progress value={p.progress} className="mt-2 h-1" />
      </div>
      <Link href={`/tasks?projectId=${p.id}`} className="text-xs text-primary hover:underline">
        {t("project.tasks")}
      </Link>
      {admin && (
        <button type="button" onClick={() => confirm(t("project.confirmDelete", { name: p.name })) && del.mutate()} aria-label={t("project.delete")}>
          <Trash2 className="size-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}

function AddProject({ clientId }: { clientId: string }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const [f, setF] = useState({ name: "", description: "", hourlyRate: 0 });
  const [open, setOpen] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post("/api/projects", { ...f, clientId }),
    onSuccess: () => (setF({ name: "", description: "", hourlyRate: 0 }), setOpen(false), invalidateClient(qc, clientId)),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Plus className="size-3.5" /> {t("project.add")}
      </Button>
    );
  return (
    <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[2fr_1fr]">
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-name`}>{t("project.namePlaceholder")}</Label>
        <Input id={`${uid}-name`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-rate`}>{t("project.hourlyRatePlaceholder")}</Label>
        <Input id={`${uid}-rate`} type="number" min={0} value={f.hourlyRate || ""} onChange={(e) => setF({ ...f, hourlyRate: Number(e.target.value) })} />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${uid}-description`}>{t("project.descriptionPlaceholder")}</Label>
        <Textarea id={`${uid}-description`} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" onClick={() => m.mutate()} disabled={!f.name || m.isPending}>
          {t("project.addProject")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {tc("cancel")}
        </Button>
      </div>
    </div>
  );
}

export function ClientProjects({ clientId, projects, currency }: { clientId: string; projects: ClientProject[]; currency: string }) {
  const t = useTranslations("clients");
  const { canEdit } = useClientRights();
  return (
    <div className="space-y-3">
      <HealthSummary projects={projects} />
      {!projects.length && <EmptyState icon={<FolderKanban className="size-7" />} title={t("project.empty")} />}
      <div className="space-y-2">
        {projects.map((p) => (
          <ProjectRow key={p.id} p={p} currency={currency} />
        ))}
      </div>
      {canEdit && <AddProject clientId={clientId} />}
    </div>
  );
}
