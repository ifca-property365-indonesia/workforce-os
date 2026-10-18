"use client";

import Link from "@/lib/nav";
import { useTranslations } from "next-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, FileText, FlaskConical, GitMerge, PauseCircle, PlayCircle, type LucideIcon } from "lucide-react";
import { hasRole, type IncidentKind, type IncidentStatus, type TaskStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

type Ref = { id: string; name: string } | null;

/** GET /api/inbox items (lib/server/inbox.ts), as JSON */
export type DecisionItem =
  | { kind: "incident"; id: string; at: string; incidentKind: IncidentKind; status: IncidentStatus; summary: string; task: { id: string; title: string; status: TaskStatus } | null; employee: Ref }
  | { kind: "held_task"; id: string; at: string; title: string; employee: Ref; team: Ref }
  | { kind: "paused_employee"; id: string; at: string; name: string; role: string }
  | { kind: "merge"; id: string; at: string; title: string; employee: Ref; repository: { id: string; name: string; defaultBranch: string }; state: "unmerged" | "failed"; conflicts: string[] }
  | { kind: "test_findings"; id: string; at: string; app: { id: string; name: string }; summary: string; findings: number; high: number; commit: string | null }
  | { kind: "doc_review"; id: string; at: string; app: { id: string; name: string }; docKind: "prd" | "flow" | "test_guide" | "deck"; version: number; title: string; note: string; author: string | null };

export interface InboxResponse {
  items: DecisionItem[];
  approvals: number;
  approvalsWaiting: number;
  counts: { approval: number; incident: number; held_task: number; paused_employee: number; merge: number; test_findings: number; doc_review: number; total: number };
}

const KIND_ICON: Record<DecisionItem["kind"], LucideIcon> = { incident: AlertTriangle, held_task: PlayCircle, paused_employee: PauseCircle, merge: GitMerge, test_findings: FlaskConical, doc_review: FileText };
const KIND_TONE: Record<DecisionItem["kind"], string> = {
  incident: "border-destructive/40",
  held_task: "border-[var(--sign-biru)]/40",
  paused_employee: "border-warning/50",
  merge: "border-warning/50",
  test_findings: "border-destructive/40",
  doc_review: "border-[var(--sign-biru)]/40",
};
const ICON_TONE: Record<DecisionItem["kind"], string> = {
  incident: "text-destructive",
  held_task: "text-[var(--sign-biru)]",
  paused_employee: "text-warning",
  merge: "text-warning",
  test_findings: "text-destructive",
  doc_review: "text-[var(--sign-biru)]",
};

/** One thing that waits for a person besides an approval: what it is, who it concerns, and what can be done now. */
export function DecisionItemCard({ item }: { item: DecisionItem }) {
  const t = useTranslations("approvals.inbox");
  const tk = useTranslations("dashboard.incidents.kind");
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  // viewers see what waits; members and up can act on it
  const canAct = !!me && hasRole(me.role, "MEMBER");
  const done = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: ["incidents"] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const taskAction = useMutation({
    mutationFn: (v: { taskId: string; action: "start" | "cancel" | "retry" }) => api.post(`/api/tasks/${v.taskId}/actions`, { action: v.action }),
    onSuccess: (_r, v) => done(t(`done.${v.action}`)),
    onError: (e) => toast.error((e as Error).message),
  });
  const closeIncident = useMutation({
    mutationFn: (id: string) => api.post(`/api/incidents/${id}`, { action: "resolve" }),
    onSuccess: () => done(t("done.resolved")),
    onError: (e) => toast.error((e as Error).message),
  });
  const handleTest = useMutation({
    mutationFn: (v: { appId: string; testId: string }) => api.post(`/api/apps/${v.appId}/tests/${v.testId}`, { action: "handled" }),
    onSuccess: () => done(t("done.handled")),
    onError: (e) => toast.error((e as Error).message),
  });
  const busy = taskAction.isPending || closeIncident.isPending || handleTest.isPending;
  const Icon = KIND_ICON[item.kind];

  let label: string;
  let title: string;
  let meta: string[] = [];
  let body: string | null = null;
  let actions: React.ReactNode = null;
  switch (item.kind) {
    case "incident":
      label = `${tk(item.incidentKind)} · ${t(`incidentStatus.${item.status}`)}`;
      title = item.task?.title ?? t("incidentNoTask");
      meta = [item.employee?.name ?? ""];
      body = item.summary || null;
      actions = (
        <>
          {item.task && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/tasks/${item.task.id}`}>{t("actions.openTask")}</Link>
            </Button>
          )}
          {canAct && item.task?.status === "FAILED" && (
            <Button size="sm" disabled={busy} onClick={() => taskAction.mutate({ taskId: item.task!.id, action: "retry" })}>
              {t("actions.retry")}
            </Button>
          )}
          {canAct && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => closeIncident.mutate(item.id)}>
              {t("actions.close")}
            </Button>
          )}
        </>
      );
      break;
    case "held_task":
      label = t("kind.held_task");
      title = item.title;
      meta = [item.team?.name ?? "", item.employee?.name ?? ""];
      body = t("heldExplain");
      actions = (
        <>
          <Button asChild size="sm" variant="outline">
            <Link href={`/tasks/${item.id}`}>{t("actions.openTask")}</Link>
          </Button>
          {canAct && (
            <>
              <Button size="sm" disabled={busy} onClick={() => taskAction.mutate({ taskId: item.id, action: "start" })}>
                {t("actions.start")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => taskAction.mutate({ taskId: item.id, action: "cancel" })}>
                {t("actions.cancel")}
              </Button>
            </>
          )}
        </>
      );
      break;
    case "paused_employee":
      label = t("kind.paused_employee");
      title = item.name;
      meta = [item.role];
      body = t("pausedExplain");
      actions = (
        <Button asChild size="sm" variant="outline">
          <Link href={`/employees/${item.id}`}>{t("actions.openEmployee")}</Link>
        </Button>
      );
      break;
    case "test_findings":
      label = item.high ? t("kind.testFindingsHigh", { count: item.findings, high: item.high }) : t("kind.testFindings", { count: item.findings });
      title = item.app.name;
      meta = [item.commit ? item.commit.slice(0, 8) : ""];
      body = item.summary || null;
      actions = (
        <>
          <Button asChild size="sm" variant="outline">
            <Link href={`/apps/${item.app.id}?test=${item.id}`}>{t("actions.openTest")}</Link>
          </Button>
          {canAct && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => handleTest.mutate({ appId: item.app.id, testId: item.id })}>
              {t("actions.handled")}
            </Button>
          )}
        </>
      );
      break;
    case "doc_review":
      label = t("kind.docReview", { doc: t(`docKind.${item.docKind}`), version: item.version });
      title = `${item.app.name}: ${item.title}`;
      meta = [item.author ?? ""];
      body = item.note || null;
      actions = (
        <Button asChild size="sm" variant="outline">
          <Link href={`/apps/${item.app.id}?doc=${item.id}`}>{t("actions.reviewDoc")}</Link>
        </Button>
      );
      break;
    case "merge":
      label = item.state === "failed" ? t("kind.mergeFailed") : t("kind.merge", { branch: item.repository.defaultBranch });
      title = item.title;
      meta = [item.repository.name, item.employee?.name ?? ""];
      body = item.state === "failed" && item.conflicts.length ? t("conflicts", { files: item.conflicts.join(", ") }) : t("mergeExplain", { branch: item.repository.defaultBranch });
      actions = (
        <Button asChild size="sm" variant="outline">
          <Link href={`/tasks/${item.id}?tab=code`}>{t("actions.reviewMerge")}</Link>
        </Button>
      );
      break;
  }

  return (
    <article id={item.id} className={cn("rounded-xl border bg-card px-3.5 py-3", KIND_TONE[item.kind])}>
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Icon className={cn("size-4 shrink-0", ICON_TONE[item.kind])} aria-hidden />
        <span className="min-w-0 flex-1 truncate uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground">{f.ago(item.at)}</span>
      </div>
      <h3 className="mt-1.5 break-words text-[15px] font-semibold leading-snug">{title}</h3>
      {meta.filter(Boolean).length > 0 && <p className="truncate text-xs text-muted-foreground">{meta.filter(Boolean).join(" · ")}</p>}
      {body && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{body}</p>}
      {actions && <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}
