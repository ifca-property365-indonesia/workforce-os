"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, GitBranch, Plus } from "lucide-react";
import { TASK_STATUSES, type TaskStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Avatar, PageHeader } from "@/components/layout/common";
import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { api } from "@/lib/api";
import { ago, credits, STATUS_LABEL, STATUS_TONE } from "@/lib/format";
import { useClients, useEmployees, useTeams, type TaskRow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const sel = "h-9 rounded-md border bg-background px-2 text-sm";

function Board() {
  const sp = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const employeeId = sp.get("employeeId") ?? "";
  const clientId = sp.get("clientId") ?? "";
  const projectId = sp.get("projectId") ?? "";
  const focus = sp.get("status") as TaskStatus | null;
  const qs = new URLSearchParams({ ...(employeeId && { employeeId }), ...(clientId && { clientId }), ...(projectId && { projectId }) }).toString();
  const { data } = useQuery({ queryKey: ["tasks", qs], queryFn: () => api.get<{ tasks: TaskRow[] }>(`/api/tasks?${qs}`).then((r) => r.tasks) });
  const { data: emps } = useEmployees();
  const { data: clients } = useClients();
  const { data: teams } = useTeams();
  const emp = new Map((emps ?? []).map((e) => [e.id, e]));
  const client = new Map((clients ?? []).map((c) => [c.id, c]));
  const team = new Map((teams ?? []).map((t) => [t.id, t]));
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v);
    else n.delete(k);
    if (k === "clientId") n.delete("projectId");
    router.replace(`/tasks?${n.toString()}`);
  };
  const projects = clientId ? (client.get(clientId)?.projects ?? []) : (clients ?? []).flatMap((c) => c.projects);

  return (
    <div>
      <PageHeader
        title="Task board"
        description="Live Kanban by status. Subtasks from team leads show their parent."
        actions={
          <Button onClick={() => setOpen(true)} className="gap-1.5">
            <Plus className="size-4" /> New task
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <select className={sel} value={employeeId} onChange={(e) => setParam("employeeId", e.target.value)}>
          <option value="">All employees</option>
          {emps?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.avatar} {e.name}
            </option>
          ))}
        </select>
        <select className={sel} value={clientId} onChange={(e) => setParam("clientId", e.target.value)}>
          <option value="">All clients</option>
          {clients?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className={sel} value={projectId} onChange={(e) => setParam("projectId", e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 overflow-x-auto pb-2 md:grid-cols-3 xl:grid-cols-6">
        {TASK_STATUSES.map((s) => {
          const items = data?.filter((t) => t.status === s) ?? [];
          return (
            <div key={s} className={cn("flex min-h-40 flex-col rounded-xl bg-muted/40 p-2", focus === s && "ring-2 ring-primary")}>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[s])}>{STATUS_LABEL[s]}</span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map((t) => {
                  const a = t.assigneeId ? emp.get(t.assigneeId) : undefined;
                  return (
                    <Link key={t.id} href={`/tasks/${t.id}`} className="block rounded-lg border bg-card p-2.5 text-sm shadow-xs transition hover:shadow-md">
                      <div className="line-clamp-3 font-medium">{t.title}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {a && (
                          <span className="inline-flex items-center gap-1">
                            <Avatar emoji={a.avatar} size="sm" className="size-4 text-[10px]" /> {a.name}
                          </span>
                        )}
                        {!a && t.teamId && <span>👥 {team.get(t.teamId)?.name}</span>}
                        {t.clientId && <span className="rounded bg-muted px-1">{client.get(t.clientId)?.name}</span>}
                        {t.dryRun && (
                          <span className="inline-flex items-center gap-0.5 text-violet-600">
                            <FlaskConical className="size-3" /> dry
                          </span>
                        )}
                        {t.parentTaskId && (
                          <span className="inline-flex items-center gap-0.5">
                            <GitBranch className="size-3" /> sub
                          </span>
                        )}
                        {t.phase === "wait" && <span className="text-sky-600">waiting on subtasks</span>}
                      </div>
                      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                        <span>{ago(t.updatedAt)}</span>
                        <span className="tabular-nums">{credits(t.costCredits)} cr</span>
                      </div>
                      {t.error && t.status !== "DONE" && <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{t.error}</div>}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <NewTaskDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <Board />
    </Suspense>
  );
}
