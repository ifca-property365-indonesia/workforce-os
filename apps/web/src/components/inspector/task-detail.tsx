"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
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
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { StepKind, TaskStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, StatusBadge } from "@/components/layout/common";
import { api } from "@/lib/api";
import { ago, credits, dateTime, ms, usd } from "@/lib/format";
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
};

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
              l.startsWith("+") && !l.startsWith("+++") && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
              l.startsWith("-") && !l.startsWith("---") && "bg-red-500/15 text-red-800 dark:text-red-300",
              l.startsWith("@@") && "text-sky-600",
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

export function StepTimeline({ steps, employees }: { steps: Step[]; employees: Map<string, { name: string; avatar: string }> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const totals = steps.reduce(
    (a, s) => ({ in: a.in + s.inputTokens, out: a.out + s.outputTokens, credits: a.credits + s.credits, latency: a.latency + (s.kind === "llm" ? s.latencyMs : 0) }),
    { in: 0, out: 0, credits: 0, latency: 0 },
  );
  if (!steps.length) return <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-md bg-muted/60 p-2">
          Tokens in <div className="text-sm font-semibold tabular-nums">{totals.in.toLocaleString()}</div>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          Tokens out <div className="text-sm font-semibold tabular-nums">{totals.out.toLocaleString()}</div>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          Model time <div className="text-sm font-semibold tabular-nums">{ms(totals.latency)}</div>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          Cost <div className="text-sm font-semibold tabular-nums">{credits(totals.credits)} cr · {usd(totals.credits)}</div>
        </div>
      </div>
      <ol className="relative space-y-1 border-l pl-4">
        {steps.map((s) => {
          const Icon = KIND_ICON[s.kind] ?? Bot;
          const isOpen = open.has(s.id);
          const emp = s.employeeId ? employees.get(s.employeeId) : undefined;
          const bad = ["error", "blocked", "denied"].includes(s.status);
          const warn = ["flagged", "pending", "simulated", "drafted"].includes(s.status);
          return (
            <li key={s.id} className="relative">
              <span
                className={cn(
                  "absolute -left-[23px] top-2 flex size-4 items-center justify-center rounded-full border bg-background",
                  bad && "border-destructive text-destructive",
                  warn && "border-amber-500 text-amber-600",
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
                <span className="font-medium">{s.name}</span>
                <span className="rounded bg-muted px-1.5 text-[11px] uppercase text-muted-foreground">{s.kind}</span>
                {s.status !== "ok" && <span className={cn("text-xs", bad ? "text-destructive" : "text-amber-600")}>{s.status}</span>}
                <span className="ml-auto flex flex-wrap items-center gap-3 text-xs tabular-nums text-muted-foreground">
                  {s.model && <span>{s.model}</span>}
                  {(s.inputTokens > 0 || s.outputTokens > 0) && (
                    <span>
                      {s.inputTokens.toLocaleString()}→{s.outputTokens.toLocaleString()} tok
                    </span>
                  )}
                  {s.latencyMs > 0 && <span>{ms(s.latencyMs)}</span>}
                  <span className="w-16 text-right">{credits(s.credits)} cr</span>
                </span>
              </button>
              {isOpen && (
                <div className="mb-2 ml-6 space-y-2 text-xs">
                  <div className="text-muted-foreground">
                    {dateTime(s.createdAt)}
                    {s.cacheReadTokens > 0 && ` · cache read ${s.cacheReadTokens.toLocaleString()}`}
                    {s.cacheWriteTokens > 0 && ` · cache write ${s.cacheWriteTokens.toLocaleString()}`}
                  </div>
                  {s.input != null && (
                    <div>
                      <div className="mb-1 font-medium">Input / arguments</div>
                      <Json value={s.input} />
                    </div>
                  )}
                  {s.output != null && (
                    <div>
                      <div className="mb-1 font-medium">Output / result</div>
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
  const [open, setOpen] = useState<string | null>(items[items.length - 1]?.id ?? null);
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">No deliverables yet.</p>;
  return (
    <div className="space-y-2">
      {items.map((d) => (
        <div key={d.id} className="rounded-lg border">
          <button type="button" onClick={() => setOpen(open === d.id ? null : d.id)} className="flex w-full items-center gap-2 p-3 text-left text-sm">
            {d.kind === "simulated_action" ? <FlaskConical className="size-4 text-violet-600" /> : <FileText className="size-4 text-muted-foreground" />}
            <span className="flex-1 font-medium">{d.title}</span>
            <span className="rounded bg-muted px-1.5 text-[11px] uppercase">{d.kind.replace("_", " ")}</span>
            {d.diff && <span className="rounded bg-sky-500/15 px-1.5 text-[11px] text-sky-700 dark:text-sky-300">new version</span>}
            <span className="text-xs text-muted-foreground">{ago(d.createdAt)}</span>
          </button>
          {open === d.id && (
            <div className="space-y-3 border-t p-3">
              {d.meta && (d.meta.to as string[] | undefined) && (
                <div className="text-xs text-muted-foreground">
                  To: {(d.meta.to as string[]).join(", ")}
                </div>
              )}
              {d.diff ? (
                <Tabs defaultValue="content">
                  <TabsList>
                    <TabsTrigger value="content">Content</TabsTrigger>
                    <TabsTrigger value="diff">Diff vs previous</TabsTrigger>
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
  const { data, refetch } = useQuery({ queryKey: ["task", taskId], queryFn: () => api.get<Detail>(`/api/tasks/${taskId}`) });
  const { data: stepsData } = useQuery({
    queryKey: ["steps", taskId],
    queryFn: () => api.get<{ steps: Step[] }>(`/api/tasks/${taskId}/steps?include=children`),
  });
  const action = useMutation({
    mutationFn: (a: "start" | "cancel" | "retry" | "dry_run") => api.post<{ taskId?: string }>(`/api/tasks/${taskId}/actions`, { action: a }),
    onSuccess: (r, a) => {
      toast.success(a === "cancel" ? "Task cancelled" : a === "dry_run" ? "Dry run started" : "Task queued");
      if (r.taskId && r.taskId !== taskId) location.href = `/tasks/${r.taskId}`;
      void refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { task, children, approvals, messages, parent } = data;
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  const assignee = task.assigneeId ? emp.get(task.assigneeId) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          {parent && (
            <Link href={`/tasks/${parent.id}`} className="text-xs text-primary hover:underline">
              ↑ Subtask of {parent.title}
            </Link>
          )}
          <h2 className={cn("font-semibold", compact ? "text-lg" : "text-xl")}>{task.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={task.status} />
            {task.dryRun && <span className="rounded-full bg-violet-500/15 px-2 py-0.5 font-medium text-violet-700 dark:text-violet-300">dry run</span>}
            {task.phase && task.teamId && <span className="rounded-full bg-muted px-2 py-0.5">team: {task.phase}</span>}
            {assignee && (
              <span className="inline-flex items-center gap-1">
                <Avatar emoji={assignee.avatar} size="sm" /> {assignee.name}
              </span>
            )}
            <span>source: {task.source}</span>
            <span>
              cost {credits(task.costCredits)} cr ({usd(task.costCredits)})
            </span>
            <span>created {ago(task.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {task.status === "QUEUED" && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("start")} className="gap-1">
              <Play className="size-3.5" /> Start
            </Button>
          )}
          {["QUEUED", "RUNNING", "AWAITING_APPROVAL"].includes(task.status) && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("cancel")} className="gap-1">
              <Ban className="size-3.5" /> Cancel
            </Button>
          )}
          {["FAILED", "CANCELLED", "DONE"].includes(task.status) && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("retry")} className="gap-1">
              <RotateCcw className="size-3.5" /> {task.status === "DONE" ? "Run again" : "Retry"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => action.mutate("dry_run")} className="gap-1">
            <FlaskConical className="size-3.5" /> Dry run
          </Button>
        </div>
      </div>

      {task.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{task.error}</div>}

      <div className={cn("grid gap-4", !compact && "lg:grid-cols-5")}>
        <div className={cn("space-y-4", !compact && "lg:col-span-2")}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Brief</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.brief || "—"}</p>
            </CardContent>
          </Card>
          {task.result && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Result</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{task.result}</p>
              </CardContent>
            </Card>
          )}
          {approvals.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Approvals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {approvals.map((a) => (
                  <Link key={a.id} href={`/approvals?focus=${a.id}`} className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-accent">
                    <span className="truncate">{a.title}</span>
                    <span className={cn("text-xs font-medium", a.status === "PENDING" ? "text-amber-600" : a.status === "REJECTED" || a.status === "FAILED" ? "text-destructive" : "text-emerald-600")}>
                      {a.status}
                    </span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {children.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Subtasks</CardTitle>
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
                <CardTitle className="text-sm">Inter-agent channel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {messages.map((m) => (
                  <div key={m.id} className="rounded-md border p-2 text-xs">
                    <div className="mb-0.5 font-medium">
                      {m.fromEmployeeId ? emp.get(m.fromEmployeeId)?.name : "system"} → {m.toEmployeeId ? emp.get(m.toEmployeeId)?.name : "—"}{" "}
                      <span className="rounded bg-muted px-1 uppercase text-muted-foreground">{m.intent}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{m.content}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
        <div className={cn(!compact && "lg:col-span-3")}>
          <Tabs defaultValue="activity">
            <TabsList>
              <TabsTrigger value="activity">Activity ({stepsData?.steps.length ?? 0})</TabsTrigger>
              <TabsTrigger value="deliverables">Deliverables ({task.deliverables.length + children.reduce((s, c) => s + c.deliverables.length, 0)})</TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className="mt-3">
              <StepTimeline steps={stepsData?.steps ?? []} employees={emp} />
            </TabsContent>
            <TabsContent value="deliverables" className="mt-3">
              <Deliverables items={[...children.flatMap((c) => c.deliverables), ...task.deliverables]} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
