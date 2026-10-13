"use client";

import Link from "@/lib/nav";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  Bot,
  ChevronRight,
  Cpu,
  FileText,
  FlaskConical,
  MessageSquareShare,
  Minimize2,
  Play,
  RotateCcw,
  Repeat,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { StepKind, TaskStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodePanel } from "./code-panel";
import { TaskPreviews } from "@/components/apps/task-previews";
import { TaskProgressHeader } from "@/components/tasks/task-progress";
import { Avatar, StatusBadge } from "@/components/layout/common";
import { api } from "@/lib/api";
import type { TaskPreview } from "@/lib/app-previews";
import { describeStep } from "@/lib/step-labels";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface Deliverable {
  id: string;
  kind: string;
  title: string;
  content: string;
  diff?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}
interface TaskFull {
  id: string;
  title: string;
  brief: string;
  status: TaskStatus;
  source: string;
  dryRun: boolean;
  phase: string | null;
  assigneeId: string | null;
  teamId: string | null;
  parentTaskId: string | null;
  deliverables: Deliverable[];
  result: string | null;
  error: string | null;
  costCredits: number;
  progress: number | null;
  progressNote: string | null;
  progressAt: string | null;
  progressDerived?: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
interface Step {
  id: string;
  taskId: string | null;
  employeeId: string | null;
  kind: StepKind;
  name: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  credits: number;
  input: unknown;
  output: unknown;
  status: string;
  createdAt: string;
}
interface Detail {
  task: TaskFull;
  children: TaskFull[];
  parent: { id: string; title: string } | null;
  approvals: { id: string; title: string; status: string; toolName: string; createdAt: string }[];
  messages: { id: string; fromEmployeeId: string | null; toEmployeeId: string | null; intent: string; content: string; createdAt: string; taskId: string | null }[];
  employees: { id: string; name: string; avatar: string }[];
  /** previews this task published (request_preview), newest first */
  previews: TaskPreview[];
}

const KIND_ICON: Record<StepKind, typeof Cpu> = {
  llm: Cpu,
  tool: Wrench,
  guard: ShieldAlert,
  approval: ShieldCheck,
  agent_message: MessageSquareShare,
  compaction: Minimize2,
  budget: AlertTriangle,
  system: Bot,
  error: AlertTriangle,
  incident: AlertOctagon,
};

/** Step statuses, including gate decisions (run / draft / approval / simulate / deny) and incident states. */
const BAD_STATUS = ["error", "blocked", "denied", "deny", "stopped"];
const WARN_STATUS = ["flagged", "pending", "simulated", "drafted", "approval", "draft", "simulate", "open", "escalated"];

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 text-xs leading-5">
      {diff
        .split("\n")
        .filter((l) => !l.startsWith("===="))
        .map((l, i) => (
          <div
            key={i}
            className={cn(
              l.startsWith("+") && !l.startsWith("+++") && "bg-success/15 text-success",
              l.startsWith("-") && !l.startsWith("---") && "bg-destructive/15 text-destructive",
              l.startsWith("@@") && "text-[var(--sign-biru)] dark:text-[color-mix(in_srgb,var(--sign-biru)_60%,white)]",
            )}
          >
            {l || " "}
          </div>
        ))}
    </pre>
  );
}

function Json({ value }: { value: unknown }) {
  if (value == null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs">{s}</pre>;
}

/** A step's name, translated where the worker records a known shape (gate decisions, incidents, guards). */
function StepName({ step }: { step: Step }) {
  const t = useTranslations("inspector");
  const info = describeStep(step);
  if (info.type === "gate") return <span className="font-medium">{t("stepName.gate", { target: info.target })}</span>;
  if (info.type === "repeat") return <span className="font-medium">{t("stepName.repeat_detected")}</span>;
  if (info.type === "incident") {
    const kind = info.kind ? t(`incidentKind.${info.kind}`) : "—";
    const known = t.has(`stepName.incident.${info.action}`);
    return <span className="font-medium">{known ? t(`stepName.incident.${info.action}`, { kind }) : step.name}</span>;
  }
  if (info.type === "stopped") return <span className="font-medium">{t(`stoppedTitle.${info.reason}`)}</span>;
  return <span className="font-medium">{step.name}</span>;
}

export function StepTimeline({ steps, employees }: { steps: Step[]; employees: Map<string, { name: string; avatar: string }> }) {
  const t = useTranslations("inspector");
  const f = useFormat();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const totals = steps.reduce(
    (a, s) => ({ in: a.in + s.inputTokens, out: a.out + s.outputTokens, credits: a.credits + s.credits, latency: a.latency + (s.kind === "llm" ? s.latencyMs : 0) }),
    { in: 0, out: 0, credits: 0, latency: 0 },
  );
  if (!steps.length) return <p className="py-6 text-center text-sm text-muted-foreground">{t("activity.empty")}</p>;
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-md bg-muted/60 p-2">
          {t("activity.tokensIn")} <div className="text-sm font-semibold tabular-nums">{f.number(totals.in)}</div>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          {t("activity.tokensOut")} <div className="text-sm font-semibold tabular-nums">{f.number(totals.out)}</div>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          {t("activity.modelTime")} <div className="text-sm font-semibold tabular-nums">{f.ms(totals.latency)}</div>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          {t("activity.cost")} <div className="text-sm font-semibold tabular-nums">{t("activity.costValue", { credits: f.credits(totals.credits), usd: f.usd(totals.credits) })}</div>
        </div>
      </div>
      <ol className="relative space-y-1 border-l pl-4">
        {steps.map((s) => {
          const info = describeStep(s);
          const Icon = info.type === "repeat" ? Repeat : info.type === "gate" ? ShieldCheck : (KIND_ICON[s.kind] ?? Bot);
          const isOpen = open.has(s.id);
          const emp = s.employeeId ? employees.get(s.employeeId) : undefined;
          const bad = BAD_STATUS.includes(s.status) || info.type === "stopped";
          const warn = WARN_STATUS.includes(s.status) || info.type === "repeat";
          return (
            <li key={s.id} className="relative">
              <span
                className={cn(
                  "absolute -left-[23px] top-2 flex size-4 items-center justify-center rounded-full border bg-background",
                  bad && "border-destructive text-destructive",
                  warn && "border-approval text-warning",
                )}
              >
                <Icon className="size-2.5" />
              </span>
              <button
                type="button"
                onClick={() => setOpen((o) => (o.has(s.id) ? (o.delete(s.id), new Set(o)) : new Set(o.add(s.id))))}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")} />
                {emp && <span title={emp.name}>{emp.avatar}</span>}
                <StepName step={s} />
                <span className="rounded bg-muted px-1.5 text-[11px] uppercase text-muted-foreground">{t.has(`stepKind.${s.kind}`) ? t(`stepKind.${s.kind}`) : s.kind}</span>
                {info.type === "gate" && info.rule && (
                  <span className="rounded border px-1.5 text-[11px] text-muted-foreground" title={info.reason ?? undefined}>
                    {t(`gateRule.${info.rule}`)}
                  </span>
                )}
                {s.status !== "ok" && (
                  <span className={cn("text-xs", bad ? "text-destructive" : warn ? "text-warning" : "text-muted-foreground")}>
                    {t.has(`stepStatus.${s.status}`) ? t(`stepStatus.${s.status}`) : s.status}
                  </span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-3 text-xs tabular-nums text-muted-foreground">
                  {s.model && <span>{s.model}</span>}
                  {(s.inputTokens > 0 || s.outputTokens > 0) && (
                    <span>{t("activity.tokens", { input: f.number(s.inputTokens), output: f.number(s.outputTokens) })}</span>
                  )}
                  {s.latencyMs > 0 && <span>{f.ms(s.latencyMs)}</span>}
                  <span className="w-16 text-right">{t("activity.credits", { amount: f.credits(s.credits) })}</span>
                </span>
              </button>
              {isOpen && (
                <div className="mb-2 ml-6 space-y-2 text-xs">
                  <div className="text-muted-foreground">
                    {f.dateTime(s.createdAt)}
                    {s.cacheReadTokens > 0 && ` · ${t("activity.cacheRead", { count: f.number(s.cacheReadTokens) })}`}
                    {s.cacheWriteTokens > 0 && ` · ${t("activity.cacheWrite", { count: f.number(s.cacheWriteTokens) })}`}
                  </div>
                  {s.input != null && (
                    <div>
                      <div className="mb-1 font-medium">{t("activity.input")}</div>
                      <Json value={s.input} />
                    </div>
                  )}
                  {s.output != null && (
                    <div>
                      <div className="mb-1 font-medium">{t("activity.output")}</div>
                      <Json value={s.output} />
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Deliverables({ items }: { items: Deliverable[] }) {
  const t = useTranslations("inspector");
  const f = useFormat();
  const [open, setOpen] = useState<string | null>(items[items.length - 1]?.id ?? null);
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">{t("deliverables.empty")}</p>;
  return (
    <div className="space-y-2">
      {items.map((d) => (
        <div key={d.id} className="rounded-lg border">
          <button type="button" onClick={() => setOpen(open === d.id ? null : d.id)} className="flex w-full items-center gap-2 p-3 text-left text-sm">
            {d.kind === "simulated_action" ? <FlaskConical className="size-4 text-[var(--sign-ungu)] dark:text-[color-mix(in_srgb,var(--sign-ungu)_55%,white)]" /> : <FileText className="size-4 text-muted-foreground" />}
            <span className="flex-1 font-medium">{d.title}</span>
            <span className="rounded bg-muted px-1.5 text-[11px] uppercase">{t.has(`deliverableKind.${d.kind}`) ? t(`deliverableKind.${d.kind}`) : d.kind.replaceAll("_", " ")}</span>
            {d.diff && <span className="rounded bg-[var(--sign-biru)]/15 px-1.5 text-[11px] text-[var(--sign-biru)] dark:text-[color-mix(in_srgb,var(--sign-biru)_60%,white)]">{t("deliverables.newVersion")}</span>}
            <span className="text-xs text-muted-foreground">{f.ago(d.createdAt)}</span>
          </button>
          {open === d.id && (
            <div className="space-y-3 border-t p-3">
              {d.meta && (d.meta.to as string[] | undefined) && (
                <div className="text-xs text-muted-foreground">
                  {t("deliverables.to", { recipients: (d.meta.to as string[]).join(", ") })}
                </div>
              )}
              {d.diff ? (
                <Tabs defaultValue="content">
                  <TabsList>
                    <TabsTrigger value="content">{t("deliverables.content")}</TabsTrigger>
                    <TabsTrigger value="diff">{t("deliverables.diff")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="content">
                    <pre className="whitespace-pre-wrap break-words text-sm">{d.content}</pre>
                  </TabsContent>
                  <TabsContent value="diff">
                    <DiffView diff={d.diff} />
                  </TabsContent>
                </Tabs>
              ) : (
                <pre className={cn("whitespace-pre-wrap break-words text-sm", d.kind === "code" && "rounded bg-muted/50 p-2 font-mono text-xs")}>{d.content}</pre>
              )}
              {d.kind === "simulated_action" && <Json value={d.meta} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function TaskDetail({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const t = useTranslations("inspector");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const f = useFormat();
  const { data, refetch } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<Detail>(`/api/tasks/${taskId}`),
    // release.updated refreshes it; while a preview deploys, also poll (a dropped stream must not freeze it)
    refetchInterval: (q) => (q.state.data?.previews?.some((p) => p.status === "queued" || p.status === "deploying") ? 5000 : false),
  });
  const { data: stepsData } = useQuery({
    queryKey: ["steps", taskId],
    queryFn: () => api.get<{ steps: Step[] }>(`/api/tasks/${taskId}/steps?include=children`),
  });
  /** the run was stopped by the watchdog (no progress) or the repeat guard: say so above the raw error */
  const stopped = (() => {
    for (const st of [...(stepsData?.steps ?? [])].reverse()) {
      if (st.taskId !== taskId) continue;
      const info = describeStep(st);
      if (info.type === "stopped") return info.reason;
    }
    return null;
  })();
  const action = useMutation({
    mutationFn: (a: "start" | "cancel" | "retry" | "dry_run") => api.post<{ taskId?: string }>(`/api/tasks/${taskId}/actions`, { action: a }),
    onSuccess: (r, a) => {
      toast.success(a === "cancel" ? t("actions.cancelled") : a === "dry_run" ? t("actions.dryRunStarted") : t("actions.queued"));
      if (r.taskId && r.taskId !== taskId) location.href = `/tasks/${r.taskId}`;
      void refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return <p className="text-sm text-muted-foreground">{tc("loading")}</p>;
  const { task, children, approvals, messages, parent } = data;
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  const assignee = task.assigneeId ? emp.get(task.assigneeId) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          {parent && (
            <Link href={`/tasks/${parent.id}`} className="text-xs text-primary hover:underline">
              {t("task.subtaskOf", { title: parent.title })}
            </Link>
          )}
          <h2 className={cn("font-semibold", compact ? "text-lg" : "text-xl")}>{task.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={task.status} />
            {task.dryRun && <span className="rounded-full bg-[var(--sign-ungu)]/15 px-2 py-0.5 font-medium text-[var(--sign-ungu)] dark:text-[color-mix(in_srgb,var(--sign-ungu)_55%,white)]">{t("task.dryRun")}</span>}
            {task.phase && task.teamId && <span className="rounded-full bg-muted px-2 py-0.5">{t("task.team", { phase: task.phase })}</span>}
            {assignee && (
              <span className="inline-flex items-center gap-1">
                <Avatar id={assignee.id} size="sm" /> {assignee.name}
              </span>
            )}
            <span>{t("task.source", { source: t.has(`source.${task.source}`) ? t(`source.${task.source}`) : task.source })}</span>
            <span>{t("task.cost", { credits: f.credits(task.costCredits), usd: f.usd(task.costCredits) })}</span>
            <span>{t("task.created", { when: f.ago(task.createdAt) })}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {task.status === "QUEUED" && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("start")} className="gap-1">
              <Play className="size-3.5" /> {t("actions.start")}
            </Button>
          )}
          {["QUEUED", "RUNNING", "AWAITING_APPROVAL"].includes(task.status) && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("cancel")} className="gap-1">
              <Ban className="size-3.5" /> {t("actions.cancel")}
            </Button>
          )}
          {["FAILED", "CANCELLED", "DONE"].includes(task.status) && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("retry")} className="gap-1">
              <RotateCcw className="size-3.5" /> {task.status === "DONE" ? t("actions.runAgain") : t("actions.retry")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => action.mutate("dry_run")} className="gap-1">
            <FlaskConical className="size-3.5" /> {t("actions.dryRun")}
          </Button>
        </div>
      </div>

      <TaskProgressHeader task={task} />

      {task.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {stopped && <div className="font-medium">{t(`stoppedTitle.${stopped}`)}</div>}
          {stopped && <div className="mb-1 text-xs">{t(`stoppedHint.${stopped}`)}</div>}
          {task.error}
        </div>
      )}

      {!!data.previews?.length && <TaskPreviews previews={data.previews} />}

      <div className={cn("grid gap-4", !compact && "lg:grid-cols-5")}>
        <div className={cn("min-w-0 space-y-4", !compact && "lg:col-span-2")}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("task.brief")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.brief || "—"}</p>
            </CardContent>
          </Card>
          {task.result && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("task.result")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{task.result}</p>
              </CardContent>
            </Card>
          )}
          {approvals.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("task.approvals")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {approvals.map((a) => (
                  <Link key={a.id} href={`/approvals?focus=${a.id}`} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-accent">
                    <span className="min-w-0 truncate">{a.title}</span>
                    <span className={cn("shrink-0 text-xs font-medium", a.status === "PENDING" ? "text-warning" : a.status === "REJECTED" || a.status === "FAILED" ? "text-destructive" : "text-success")}>
                      {ts(`approval.${a.status}`)}
                    </span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {children.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("task.subtasks")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {children.map((c) => (
                  <Link key={c.id} href={`/tasks/${c.id}`} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent">
                    {c.assigneeId && <span>{emp.get(c.assigneeId)?.avatar}</span>}
                    <span className="flex-1 truncate">{c.title}</span>
                    <StatusBadge status={c.status} />
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {messages.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t("task.channel")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {messages.map((m) => (
                  <div key={m.id} className="rounded-md border p-2 text-xs">
                    <div className="mb-0.5 font-medium">
                      {m.fromEmployeeId ? emp.get(m.fromEmployeeId)?.name : t("task.system")} → {m.toEmployeeId ? emp.get(m.toEmployeeId)?.name : "—"}{" "}
                      <span className="rounded bg-muted px-1 uppercase text-muted-foreground">{m.intent}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{m.content}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
        <div className={cn("min-w-0", !compact && "lg:col-span-3")}>
          <Tabs defaultValue="activity">
            <TabsList>
              <TabsTrigger value="activity">{t("task.activityTab", { count: stepsData?.steps.length ?? 0 })}</TabsTrigger>
              <TabsTrigger value="deliverables">{t("task.deliverablesTab", { count: task.deliverables.length + children.reduce((s, c) => s + c.deliverables.length, 0) })}</TabsTrigger>
              {task.deliverables.some((d) => d.kind === "code" && d.meta && "branch" in d.meta) && <TabsTrigger value="code">{t("code.tab")}</TabsTrigger>}
            </TabsList>
            <TabsContent value="activity" className="mt-3">
              <StepTimeline steps={stepsData?.steps ?? []} employees={emp} />
            </TabsContent>
            <TabsContent value="deliverables" className="mt-3">
              <Deliverables items={[...children.flatMap((c) => c.deliverables), ...task.deliverables]} />
            </TabsContent>
            <TabsContent value="code" className="mt-3">
              <CodePanel taskId={task.id} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
