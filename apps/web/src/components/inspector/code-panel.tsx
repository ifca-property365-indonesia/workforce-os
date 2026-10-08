"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { GitBranch, GitCommitHorizontal, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { CodeDiff } from "./code-view";

interface CodeInfo {
  task: { id: string; status: string; workspaceStatus: string | null; resumable: boolean };
  repository: { name: string; url: string; defaultBranch: string } | null;
  code: { branch: string; head: string; commits: { sha: string; subject: string }[]; diff: string; diffTruncated?: boolean } | null;
  lastTest: { command: string; output: unknown; ok: boolean; at: string } | null;
  approvals: { id: string; toolName: string; title: string; status: string }[];
}

/** Code deliverable of a Workspace-mode task: diff, test output, and the delivery decisions. */
export function CodePanel({ taskId }: { taskId: string }) {
  const t = useTranslations("inspector");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState("");
  const { data } = useQuery({ queryKey: ["task-code", taskId], queryFn: () => api.get<CodeInfo>(`/api/tasks/${taskId}/code`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["task-code", taskId] });
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["approvals"] });
  };
  const pendingDeliveries = (data?.approvals ?? []).filter((a) => a.status === "PENDING" && (a.toolName === "git_push" || a.toolName === "create_pull_request"));
  // push first, then the pull request
  const ordered = [...pendingDeliveries].sort((a, b) => (a.toolName === "git_push" ? -1 : 1) - (b.toolName === "git_push" ? -1 : 1));
  const approve = useMutation({
    mutationFn: async () => {
      for (const a of ordered) await api.post(`/api/approvals/${a.id}/decide`, { decision: "approve" });
    },
    onSuccess: () => {
      toast.success(t("code.approved"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const changes = useMutation({
    mutationFn: () => api.post(`/api/tasks/${taskId}/actions`, { action: "request_changes", feedback }),
    onSuccess: () => {
      setFeedback("");
      toast.success(t("code.changesRequested"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const discard = useMutation({
    mutationFn: () => api.post(`/api/tasks/${taskId}/actions`, { action: "discard" }),
    onSuccess: () => {
      toast.success(t("code.discarded"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return <p className="text-sm text-muted-foreground">{tc("loading")}</p>;
  if (!data.code) return <p className="text-sm text-muted-foreground">{t("code.none")}</p>;
  const testOutput = typeof data.lastTest?.output === "string" ? data.lastTest.output : JSON.stringify(data.lastTest?.output ?? "", null, 2);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="flex items-center gap-1 font-mono">
          <GitBranch className="size-4" /> {data.code.branch}
        </span>
        {data.repository && <span className="text-muted-foreground">{t("code.into", { repository: data.repository.name, base: data.repository.defaultBranch })}</span>}
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" /> {t("code.hooksDisabled")}
        </span>
      </div>
      <ul className="space-y-0.5 text-sm">
        {data.code.commits.map((c) => (
          <li key={c.sha} className="flex items-center gap-2">
            <GitCommitHorizontal className="size-4 text-muted-foreground" />
            <code className="text-xs text-muted-foreground">{c.sha.slice(0, 8)}</code>
            <span>{c.subject}</span>
          </li>
        ))}
      </ul>
      <CodeDiff diff={data.code.diff} truncated={data.code.diffTruncated} />
      <div className="space-y-1">
        <div className="text-sm font-medium">{t("code.lastTest")}</div>
        {data.lastTest ? (
          <>
            <div className="text-xs text-muted-foreground">
              <code>{data.lastTest.command}</code> · {f.ago(data.lastTest.at)} · {data.lastTest.ok ? t("code.testOk") : t("code.testFailed")}
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{testOutput}</pre>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t("code.noTest")}</p>
        )}
      </div>
      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <div className="flex flex-wrap gap-2">
          <Button disabled={!ordered.length || approve.isPending} onClick={() => approve.mutate()}>
            {t("code.approvePush")}
          </Button>
          <Button variant="outline" disabled={discard.isPending || data.task.workspaceStatus === "discarded"} onClick={() => confirm(t("code.discardConfirm")) && discard.mutate()}>
            {t("code.discard")}
          </Button>
        </div>
        {!ordered.length && <p className="text-xs text-muted-foreground">{t("code.nothingPending")}</p>}
        {data.task.resumable && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              changes.mutate();
            }}
          >
            <Textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder={t("code.feedbackPlaceholder")} />
            <Button variant="secondary" size="sm" disabled={feedback.trim().length < 3 || changes.isPending}>
              {t("code.requestChanges")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
