"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleCheck, GitMerge, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppRights } from "@/components/apps/shared";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";

export interface MergeInfo {
  branch: string;
  head: string;
  pushedAt: string;
  state: "unmerged" | "pending" | "merged" | "skipped" | "failed";
  decidedAt: string | null;
  summary: string | null;
  commit: string | null;
  conflicts: string[];
  detected: boolean;
}

/** what the employee is told when their branch conflicts with the default branch (agent instructions: English) */
function conflictFeedback(base: string, files: string[]): string {
  return (
    `Your branch conflicts with ${base}${files.length ? ` in ${files.join(", ")}` : ""}, so it could not be merged. ` +
    `Bring it up to date: git merge upstream/${base} (upstream/${base} in your checkout is already the latest ${base}; do not fetch). Resolve each conflict keeping what is already in ${base} ` +
    "and adding your change on top (do not undo earlier work), run the tests, commit, and propose the push again."
  );
}

/**
 * The last step of a code task: merge the pushed version into the default branch, so the next task (and a deploy of
 * the default branch) starts from it. Admins decide; a conflict goes back to the employee in the same workspace.
 */
export function MergeBox({ taskId, taskStatus, base, merge, resumable }: { taskId: string; taskStatus: string; base: string; merge: MergeInfo; resumable: boolean }) {
  const t = useTranslations("inspector.code.merge");
  const f = useFormat();
  const qc = useQueryClient();
  const { admin } = useAppRights();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["task-code", taskId] });
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["repo-unmerged"] });
  };
  const decide = useMutation({
    mutationFn: (decision: "merge" | "skip") => api.post(`/api/tasks/${taskId}/merge`, { decision, head: merge.head }),
    onSuccess: (_r, decision) => {
      toast.success(decision === "merge" ? t("merging") : t("skippedToast"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const fix = useMutation({
    mutationFn: () => api.post(`/api/tasks/${taskId}/actions`, { action: "request_changes", feedback: conflictFeedback(base, merge.conflicts) }),
    onSuccess: () => {
      toast.success(t("fixRequested"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const done = taskStatus === "DONE";
  const busy = decide.isPending || fix.isPending;

  return (
    <div className="space-y-2 rounded-lg border p-3" aria-live="polite" title={`${merge.branch} · commit ${merge.head}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <GitMerge className="size-4" aria-hidden /> {t("title", { base })}
      </div>
      {merge.state === "merged" && (
        <p className="flex items-start gap-1.5 text-sm">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span>
            {merge.detected ? t("detected", { base }) : t("merged", { base })}
            {merge.decidedAt && <span className="text-muted-foreground"> · {f.ago(merge.decidedAt)}</span>}
          </span>
        </p>
      )}
      {merge.state === "pending" && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t("pending", { base })}
        </p>
      )}
      {merge.state === "skipped" && <p className="text-sm text-muted-foreground">{t("skipped", { base })}</p>}
      {merge.state === "failed" && (
        <div className="space-y-1 rounded-md bg-destructive/10 px-2 py-1.5 text-sm">
          <p className="flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span>{merge.conflicts.length ? t("conflicts", { base }) : t("failed")}</span>
          </p>
          {merge.conflicts.length > 0 ? (
            <ul className="ml-6 list-disc font-mono text-xs">
              {merge.conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            merge.summary && <p className="ml-6 text-xs text-muted-foreground">{merge.summary}</p>
          )}
        </div>
      )}
      {merge.state === "unmerged" && <p className="text-sm">{done ? t("unmerged", { base }) : t("notDone", { base })}</p>}

      {admin && done && merge.state !== "merged" && merge.state !== "pending" && (
        <div className="flex flex-wrap gap-2">
          {merge.state === "failed" && merge.conflicts.length > 0 && resumable ? (
            <Button size="sm" disabled={busy} onClick={() => fix.mutate()}>
              {t("askFix")}
            </Button>
          ) : (
            <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => confirm(t("confirm", { base })) && decide.mutate("merge")}>
              <GitMerge className="size-4" aria-hidden /> {merge.state === "failed" ? t("retry") : t("merge", { base })}
            </Button>
          )}
          {merge.state !== "skipped" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(t("skipConfirm", { base })) && decide.mutate("skip")}>
              {t("skip")}
            </Button>
          )}
        </div>
      )}
      {!admin && merge.state === "unmerged" && done && <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>}
    </div>
  );
}
