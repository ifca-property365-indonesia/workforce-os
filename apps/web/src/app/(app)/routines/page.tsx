"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { CalendarClock, ChevronDown, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState, PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { useEmployees, useTeams } from "@/lib/hooks";

interface Routine {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  brief: string;
  assigneeId: string | null;
  teamId: string | null;
  perClient: boolean;
  dryRun: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}
type Form = Omit<Routine, "id" | "nextRunAt" | "lastRunAt">;
const blank: Form = { name: "", cron: "0 9 * * 1", timezone: "Asia/Jakarta", brief: "", assigneeId: null, teamId: null, perClient: false, dryRun: false, enabled: true };
const PRESETS = [
  { key: "weeklyMonday", cron: "0 9 * * 1" },
  { key: "weekdays", cron: "0 8 * * 1-5" },
  { key: "monthly", cron: "0 10 1 * *" },
  { key: "hourly", cron: "0 * * * *" },
] as const;
/** brief template variable shown in the placeholder (not translated) */
const CLIENT_VAR = "{{client.name}}";

function RoutineDialog({ initial, id, onClose }: { initial: Form; id?: string; onClose: () => void }) {
  const t = useTranslations("routines");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const [f, setF] = useState<Form>(initial);
  const m = useMutation({
    mutationFn: () => (id ? api.patch(`/api/routines/${id}`, f) : api.post("/api/routines", f)),
    onSuccess: () => {
      toast.success(t("saved"));
      void qc.invalidateQueries({ queryKey: ["routines"] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const assignee = f.assigneeId ? `e:${f.assigneeId}` : f.teamId ? `t:${f.teamId}` : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{id ? t("editRoutine") : t("newRoutine")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{tc("name")}</Label>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("form.cron")}</Label>
              <Input value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("form.timezone")}</Label>
              <Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button key={p.cron} type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setF({ ...f, cron: p.cron })}>
                {t(`presets.${p.key}`)}
              </Button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>{t("form.assignTo")}</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={assignee}
              onChange={(e) => {
                const [k, v] = e.target.value.split(":");
                setF({ ...f, assigneeId: k === "e" ? v! : null, teamId: k === "t" ? v! : null });
              }}
            >
              <option value="">{tc("selectPlaceholder")}</option>
              {emps?.map((e) => (
                <option key={e.id} value={`e:${e.id}`}>
                  {e.avatar} {e.name}
                </option>
              ))}
              {teams?.map((tm) => (
                <option key={tm.id} value={`t:${tm.id}`}>
                  👥 {tm.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("form.brief")}</Label>
            <Textarea rows={4} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} placeholder={t("form.briefPlaceholder", { variable: CLIENT_VAR })} />
          </div>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={f.perClient} onCheckedChange={(v) => setF({ ...f, perClient: v })} /> {t("form.perClient")}
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={f.dryRun} onCheckedChange={(v) => setF({ ...f, dryRun: v })} /> {t("form.dryRun")}
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={f.enabled} onCheckedChange={(v) => setF({ ...f, enabled: v })} /> {t("form.enabled")}
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t("form.gateNote")}</p>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!f.name || !f.brief || (!f.assigneeId && !f.teamId) || m.isPending}>
            {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function History({ id }: { id: string }) {
  const t = useTranslations("routines");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["routines", id],
    queryFn: () => api.get<{ runs: { id: string; startedAt: string; trigger: string; taskIds: string[]; status: string; error: string | null }[]; upcoming: string[] }>(`/api/routines/${id}`),
  });
  return (
    <div className="grid gap-4 border-t p-4 text-sm md:grid-cols-2">
      <div>
        <div className="mb-1 font-medium">{t("history.nextRuns")}</div>
        <ul className="space-y-0.5 text-muted-foreground">
          {data?.upcoming.map((u) => (
            <li key={u}>{f.dateTime(u)}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1 font-medium">{t("history.runHistory")}</div>
        {!data?.runs.length && <p className="text-muted-foreground">{t("history.neverRan")}</p>}
        <ul className="space-y-1">
          {data?.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{f.dateTime(r.startedAt)}</span>
              <span className="rounded bg-muted px-1.5 text-[11px]">{t.has(`history.trigger.${r.trigger}`) ? t(`history.trigger.${r.trigger}`) : r.trigger}</span>
              <span className={r.status === "failed" ? "text-destructive" : ""}>{t.has(`history.status.${r.status}`) ? t(`history.status.${r.status}`) : r.status}</span>
              {r.taskIds.map((taskId, i) => (
                <Link key={taskId} href={`/tasks/${taskId}`} className="text-primary hover:underline">
                  {t("history.taskLink", { n: i + 1 })}
                </Link>
              ))}
              {r.error && <span className="text-destructive">{r.error}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function RoutinesPage() {
  const tr = useTranslations("routines");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["routines"], queryFn: () => api.get<{ routines: Routine[] }>("/api/routines").then((r) => r.routines) });
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const [edit, setEdit] = useState<{ id?: string; form: Form } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const run = useMutation({ mutationFn: (id: string) => api.post(`/api/routines/${id}/run`), onSuccess: () => toast.success(tr("dispatched")) });
  const toggle = useMutation({ mutationFn: (r: Routine) => api.patch(`/api/routines/${r.id}`, { enabled: !r.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ["routines"] }) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/routines/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["routines"] }) });

  return (
    <div>
      <PageHeader
        title={tr("title")}
        description={tr("description")}
        actions={
          <Button onClick={() => setEdit({ form: blank })} className="gap-1.5">
            <Plus className="size-4" /> {tr("newRoutine")}
          </Button>
        }
      />
      {!data?.length && <EmptyState icon={<CalendarClock className="size-8" />} title={tr("empty.title")} description={tr("empty.description")} />}
      <div className="space-y-3">
        {data?.map((r) => {
          const e = r.assigneeId ? emps?.find((x) => x.id === r.assigneeId) : undefined;
          const t = r.teamId ? teams?.find((x) => x.id === r.teamId) : undefined;
          return (
            <Card key={r.id}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <Switch checked={r.enabled} onCheckedChange={() => toggle.mutate(r)} aria-label={tr("enabledLabel")} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {r.name}
                    <code className="rounded bg-muted px-1.5 text-xs">{r.cron}</code>
                    {r.perClient && <span className="rounded bg-sky-500/15 px-1.5 text-xs text-sky-700 dark:text-sky-300">{tr("badge.perClient")}</span>}
                    {r.dryRun && <span className="rounded bg-violet-500/15 px-1.5 text-xs text-violet-700 dark:text-violet-300">{tr("badge.dryRun")}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {e ? <Avatar emoji={e.avatar} size="sm" /> : "👥"} {e?.name ?? t?.name ?? tr("unassigned")}
                    </span>
                    <span>{tr("nextRun", { when: r.enabled && r.nextRunAt ? `${f.dateTime(r.nextRunAt)} (${f.ago(r.nextRunAt)})` : "—" })}</span>
                    <span>{tr("lastRun", { when: f.ago(r.lastRunAt) })}</span>
                    <span>{r.timezone}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => run.mutate(r.id)} className="gap-1">
                    <Play className="size-3.5" /> {tr("runNow")}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setEdit({ id: r.id, form: { name: r.name, cron: r.cron, timezone: r.timezone, brief: r.brief, assigneeId: r.assigneeId, teamId: r.teamId, perClient: r.perClient, dryRun: r.dryRun, enabled: r.enabled } })} aria-label={tc("edit")}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setExpanded(expanded === r.id ? null : r.id)} aria-label={tr("toggleHistory")}>
                    <ChevronDown className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => confirm(tr("confirmDelete", { name: r.name })) && del.mutate(r.id)} aria-label={tc("delete")}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
              {expanded === r.id && <History id={r.id} />}
            </Card>
          );
        })}
      </div>
      {edit && <RoutineDialog id={edit.id} initial={edit.form} onClose={() => setEdit(null)} />}
    </div>
  );
}
