"use client";

import Link from "@/lib/nav";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ChevronDown, GitBranch, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import type { WorkflowRunStatus, WorkflowStep, WorkflowTrigger } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { LiveSchedulePreview } from "@/components/routines/schedule-preview";
import { api } from "@/lib/api";
import { useEmployees, useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
  proposedBy: string | null;
  untrustedInput: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRun: { status: WorkflowRunStatus; createdAt: string } | null;
}

interface Run {
  id: string;
  trigger: string;
  status: WorkflowRunStatus;
  stepIndex: number;
  steps: WorkflowStep[];
  outputs: string[];
  waitingTaskId: string | null;
  waitingApprovalId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type Form = Pick<Workflow, "name" | "description" | "trigger" | "steps">;
const KINDS = ["agent", "condition", "approval", "notify"] as const;
const blankStep = (kind: WorkflowStep["kind"], employeeId = ""): WorkflowStep =>
  kind === "agent" ? { kind, employeeId, instruction: "" } : kind === "condition" ? { kind, mode: "contains", text: "" } : { kind, title: "" };

const STATUS_TONE: Record<WorkflowRunStatus, string> = {
  running: "text-[var(--sign-biru)]",
  waiting: "text-warning",
  done: "text-success",
  stopped: "text-muted-foreground",
  failed: "text-destructive",
};

/** The steps as short chips: "1 · Rina → 2 · Condition → …" */
function StepChips({ steps, names }: { steps: WorkflowStep[]; names: (id: string) => string }) {
  const t = useTranslations("workflows");
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">→</span>}
          <span className="rounded bg-muted px-1.5 py-0.5">
            {i + 1} · {s.kind === "agent" ? names(s.employeeId) : t(`kind.${s.kind}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepEditor({
  step,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  step: WorkflowStep;
  index: number;
  count: number;
  onChange: (s: WorkflowStep) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("workflows");
  const tc = useTranslations("common");
  const { data: emps } = useEmployees();
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{index + 1}</span>
        <select
          aria-label={t("form.kind")}
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={step.kind}
          onChange={(e) => onChange(blankStep(e.target.value as WorkflowStep["kind"], emps?.[0]?.id))}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-0.5">
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t("form.moveUp")}>
            <ArrowUp className="size-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t("form.moveDown")}>
            <ArrowDown className="size-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={count === 1} onClick={onRemove} aria-label={tc("delete")}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {step.kind === "agent" && (
        <>
          <select aria-label={t("form.employee")} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={step.employeeId} onChange={(e) => onChange({ ...step, employeeId: e.target.value })}>
            <option value="">{tc("selectPlaceholder")}</option>
            {emps?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.avatar} {e.name}
              </option>
            ))}
          </select>
          <Textarea aria-label={t("form.instruction")} placeholder={t("form.instructionPlaceholder")} value={step.instruction} onChange={(e) => onChange({ ...step, instruction: e.target.value })} className="min-h-20" />
          {index > 0 && <p className="text-xs text-muted-foreground">{t("form.previousOutputHint")}</p>}
        </>
      )}
      {step.kind === "condition" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t("form.conditionLead")}</span>
          <select aria-label={t("form.conditionMode")} className="h-9 rounded-md border bg-background px-2 text-sm" value={step.mode} onChange={(e) => onChange({ ...step, mode: e.target.value as "contains" | "not_contains" })}>
            <option value="contains">{t("form.contains")}</option>
            <option value="not_contains">{t("form.notContains")}</option>
          </select>
          <Input aria-label={t("form.conditionText")} className="w-48" value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} />
        </div>
      )}
      {(step.kind === "approval" || step.kind === "notify") && (
        <Input
          aria-label={t("form.title")}
          placeholder={t(step.kind === "approval" ? "form.approvalPlaceholder" : "form.notifyPlaceholder")}
          value={step.title}
          onChange={(e) => onChange({ ...step, title: e.target.value })}
        />
      )}
    </li>
  );
}

function WorkflowDialog({ initial, id, onClose }: { initial: Form; id?: string; onClose: () => void }) {
  const t = useTranslations("workflows");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(initial);
  const save = useMutation({
    mutationFn: () => (id ? api.patch(`/api/workflows/${id}`, f) : api.post("/api/workflows", f)),
    onSuccess: () => {
      toast.success(t("saved"));
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const setStep = (i: number, s: WorkflowStep) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, d: -1 | 1) => {
    const steps = [...f.steps];
    [steps[i], steps[i + d]] = [steps[i + d]!, steps[i]!];
    setF({ ...f, steps });
  };
  const schedule = f.trigger.kind === "schedule" ? f.trigger : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{id ? t("edit") : t("new")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">{tc("name")}</Label>
            <Input id="wf-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-desc">{t("form.description")}</Label>
            <Textarea id="wf-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="min-h-14" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("form.trigger")}</legend>
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={!schedule} onChange={() => setF({ ...f, trigger: { kind: "manual" } })} /> {t("trigger.manual")}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={!!schedule} onChange={() => setF({ ...f, trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Asia/Jakarta" } })} /> {t("trigger.schedule")}
              </label>
            </div>
            {schedule && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Input aria-label={t("form.cron")} value={schedule.cron} onChange={(e) => setF({ ...f, trigger: { ...schedule, cron: e.target.value } })} className="font-mono" />
                  <Input aria-label={t("form.timezone")} value={schedule.timezone} onChange={(e) => setF({ ...f, trigger: { ...schedule, timezone: e.target.value } })} />
                </div>
                <LiveSchedulePreview cron={schedule.cron} timezone={schedule.timezone} />
              </>
            )}
          </fieldset>
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("form.steps")}</div>
            <ol className="space-y-2">
              {f.steps.map((s, i) => (
                <StepEditor key={i} step={s} index={i} count={f.steps.length} onChange={(x) => setStep(i, x)} onMove={(d) => move(i, d)} onRemove={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })} />
              ))}
            </ol>
            <Button type="button" size="sm" variant="outline" className="gap-1" disabled={f.steps.length >= 12} onClick={() => setF({ ...f, steps: [...f.steps, blankStep("agent")] })}>
              <Plus className="size-3.5" /> {t("form.addStep")}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.name.trim()}>
            {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Runs({ id, names }: { id: string; names: (id: string) => string }) {
  const t = useTranslations("workflows");
  const f = useFormat();
  const { data } = useQuery({ queryKey: ["workflows", id], queryFn: () => api.get<{ runs: Run[] }>(`/api/workflows/${id}`), refetchInterval: 5000 });
  if (!data) return null;
  const stepName = (s: WorkflowStep | undefined) => (s?.kind === "agent" ? names(s.employeeId) : t(`kind.${s?.kind ?? "notify"}`));
  return (
    <div className="space-y-2 border-t p-4 text-sm">
      <div className="font-medium">{t("runs.title")}</div>
      {!data.runs.length && <p className="text-muted-foreground">{t("runs.none")}</p>}
      <ul className="space-y-2">
        {data.runs.map((r) => (
          <li key={r.id} className="space-y-1 rounded-md border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{f.dateTime(r.createdAt)}</span>
              <span className="rounded bg-muted px-1.5 text-[11px]">{t(`trigger.${r.trigger === "schedule" ? "schedule" : "manual"}`)}</span>
              <span className={cn("font-medium", STATUS_TONE[r.status])}>{t(`status.${r.status}`)}</span>
              <span className="text-xs text-muted-foreground">{t("runs.progress", { done: Math.min(r.stepIndex, r.steps.length), total: r.steps.length })}</span>
              {r.waitingTaskId && (
                <Link href={`/tasks/${r.waitingTaskId}`} className="text-xs text-primary hover:underline">
                  {t("runs.openTask")}
                </Link>
              )}
              {r.waitingApprovalId && (
                <Link href={`/approvals?focus=${r.waitingApprovalId}`} className="text-xs text-primary hover:underline">
                  {t("runs.openApproval")}
                </Link>
              )}
            </div>
            {r.error && <p className="text-xs text-destructive">{r.error}</p>}
            {r.outputs.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">{t("runs.outputs")}</summary>
                <ol className="mt-1 space-y-1">
                  {r.outputs.map((o, i) => (
                    <li key={i}>
                      <span className="font-medium">
                        {i + 1} · {stepName(r.steps[i])}
                      </span>
                      <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-muted p-1.5 break-words whitespace-pre-wrap">{o || "—"}</pre>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function WorkflowsPage() {
  const t = useTranslations("workflows");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const admin = me?.role === "OWNER" || me?.role === "ADMIN";
  const { data } = useQuery({ queryKey: ["workflows"], queryFn: () => api.get<{ workflows: Workflow[] }>("/api/workflows").then((r) => r.workflows) });
  const { data: emps } = useEmployees();
  const names = (id: string) => emps?.find((e) => e.id === id)?.name ?? "?";
  const [edit, setEdit] = useState<{ id?: string; form: Form } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["workflows"] });
  const onError = (e: unknown) => toast.error((e as Error).message);
  const run = useMutation({
    mutationFn: (id: string) => api.post(`/api/workflows/${id}/run`),
    onSuccess: () => {
      toast.success(t("started"));
      refresh();
    },
    onError,
  });
  const toggle = useMutation({ mutationFn: (w: Workflow) => api.patch(`/api/workflows/${w.id}`, { enabled: !w.enabled }), onSuccess: refresh, onError });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/workflows/${id}`), onSuccess: refresh, onError });

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          admin && (
            <Button onClick={() => setEdit({ form: { name: "", description: "", trigger: { kind: "manual" }, steps: [blankStep("agent", emps?.[0]?.id)] } })} className="gap-1.5">
              <Plus className="size-4" /> {t("new")}
            </Button>
          )
        }
      />
      {!data?.length && <EmptyState icon={<GitBranch className="size-8" />} title={t("empty.title")} description={t("empty.description")} />}
      <div className="space-y-3">
        {data?.map((w) => (
          <Card key={w.id}>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
              <Switch
                checked={w.enabled}
                disabled={!admin || toggle.isPending}
                // an employee's draft is turned on by a person who has looked at it
                onCheckedChange={() => (w.enabled || !w.proposedBy || confirm(t("confirmEnableProposed", { employee: w.proposedBy }))) && toggle.mutate(w)}
                aria-label={t("enabledLabel")}
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {w.name}
                  {w.trigger.kind === "schedule" ? <code className="rounded bg-muted px-1.5 text-xs">{w.trigger.cron}</code> : <span className="rounded bg-muted px-1.5 text-xs">{t("trigger.manual")}</span>}
                  {w.proposedBy && !w.enabled && <span className="rounded bg-warning/15 px-1.5 text-xs text-warning">{t("badge.proposed", { employee: w.proposedBy })}</span>}
                  {w.untrustedInput && <span className="rounded bg-destructive/15 px-1.5 text-xs text-destructive">{t("badge.untrusted")}</span>}
                </div>
                {w.description && <p className="text-sm text-muted-foreground">{w.description}</p>}
                <StepChips steps={w.steps} names={names} />
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {w.trigger.kind === "schedule" && <span>{t("nextRun", { when: w.enabled && w.nextRunAt ? f.dateTime(w.nextRunAt) : "—" })}</span>}
                  <span>{w.lastRun ? t("lastRun", { when: f.ago(w.lastRun.createdAt), status: t(`status.${w.lastRun.status}`) }) : t("neverRan")}</span>
                </div>
              </div>
              <div className="flex gap-1">
                {admin && (
                  <Button size="sm" variant="outline" onClick={() => run.mutate(w.id)} disabled={run.isPending} className="gap-1">
                    <Play className="size-3.5" /> {t("runNow")}
                  </Button>
                )}
                {admin && (
                  <Button size="icon" variant="ghost" onClick={() => setEdit({ id: w.id, form: { name: w.name, description: w.description, trigger: w.trigger, steps: w.steps } })} aria-label={tc("edit")}>
                    <Pencil className="size-4" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" onClick={() => setExpanded(expanded === w.id ? null : w.id)} aria-label={t("toggleRuns")}>
                  <ChevronDown className="size-4" />
                </Button>
                {admin && (
                  <Button size="icon" variant="ghost" onClick={() => confirm(t("confirmDelete", { name: w.name })) && del.mutate(w.id)} aria-label={tc("delete")}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </CardContent>
            {expanded === w.id && <Runs id={w.id} names={names} />}
          </Card>
        ))}
      </div>
      {edit && <WorkflowDialog id={edit.id} initial={edit.form} onClose={() => setEdit(null)} />}
    </div>
  );
}
