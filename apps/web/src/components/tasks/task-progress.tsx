"use client";

import { useTranslations } from "next-intl";
import { GitBranch } from "lucide-react";
import type { TaskStatus } from "@wfos/shared";
import { Progress } from "@/components/ui/progress";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

export interface ProgressFields {
  status: TaskStatus;
  progress: number | null;
  progressNote?: string | null;
  progressAt?: string | null;
  progressDerived?: boolean;
}

/** What to show: a DONE task is 100% whatever was last reported; null = nothing known. */
export function shownProgress(t: ProgressFields): number | null {
  if (t.status === "DONE") return 100;
  return t.progress == null ? null : Math.max(0, Math.min(100, Math.round(t.progress)));
}

/** Show a bar at all: a known share, or a running task (a bar that says "working" until the first report). */
export function hasProgress(t: ProgressFields): boolean {
  return t.progress != null || t.status === "RUNNING";
}

function Bar({ value, className }: { value: number | null; className?: string }) {
  if (value === null) {
    return (
      <div className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-primary/15", className)} aria-hidden>
        <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-primary/50" />
      </div>
    );
  }
  return <Progress value={value} className={cn("h-1.5", className)} aria-hidden />;
}

/**
 * Compact progress for a card or a list row: bar and percentage, and the latest note on one line. Renders nothing
 * when there is nothing to show (see hasProgress).
 */
export function TaskProgressInline({ task, showNote = true, className }: { task: ProgressFields; showNote?: boolean; className?: string }) {
  const t = useTranslations("tasks");
  if (!hasProgress(task)) return null;
  const value = shownProgress(task);
  const label = value === null ? t("progress.working") : t("progress.percent", { value });
  return (
    <div className={cn("space-y-1", className)} role="group" aria-label={t("progress.label", { value: label })}>
      <div className="flex items-center gap-2">
        <Bar value={value} className="flex-1" />
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">{label}</span>
        {task.progressDerived && task.status !== "DONE" && (
          <span title={t("progress.derived")} className="shrink-0 text-muted-foreground">
            <GitBranch className="size-3" aria-hidden />
            <span className="sr-only">{t("progress.derived")}</span>
          </span>
        )}
      </div>
      {showNote && task.progressNote && task.status !== "DONE" && <div className="line-clamp-1 text-[11px] text-muted-foreground">{task.progressNote}</div>}
    </div>
  );
}

/** "1 h 12 min" / "12 min" from seconds (whole minutes, rounded down). */
function useHoursMinutes() {
  const t = useTranslations("tasks");
  return (sec: number) => {
    const m = Math.floor(sec / 60);
    return m >= 60 ? t("sandbox.hoursMinutes", { h: Math.floor(m / 60), m: m % 60 }) : t("sandbox.minutes", { m });
  };
}

/**
 * Workspace mode: how much of the task's sandbox time (WORKSPACE_TASK_MAX_HOURS, across its runs) is used since a
 * person last let it go on. Nothing before the first run.
 */
export function TaskSandboxTime({ usedSec, limitSec }: { usedSec: number; limitSec: number }) {
  const t = useTranslations("tasks");
  const hm = useHoursMinutes();
  if (usedSec <= 0 || limitSec <= 0) return null;
  const share = Math.min(100, Math.round((usedSec / limitSec) * 100));
  const usedUp = usedSec >= limitSec;
  return (
    <div className="rounded-xl border bg-card/60 px-3 py-2" role="group" aria-label={t("sandbox.title")}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">{t("sandbox.title")}</span>
        <span className="tabular-nums">{t("sandbox.used", { used: hm(usedSec), limit: hm(limitSec) })}</span>
      </div>
      <Progress value={share} className={cn("mt-1.5 h-1", share >= 80 && "[&>div]:bg-amber-500", usedUp && "[&>div]:bg-destructive")} aria-hidden />
      {share >= 80 && <p className={cn("mt-1.5 text-xs", usedUp ? "text-destructive" : "text-muted-foreground")}>{usedUp ? t("sandbox.usedUp") : t("sandbox.nearLimit")}</p>}
    </div>
  );
}

/** The task header's progress: bar, percentage, the assignee's note and when it was reported (or that it comes from subtasks). */
export function TaskProgressHeader({ task }: { task: ProgressFields }) {
  const t = useTranslations("tasks");
  const f = useFormat();
  if (!hasProgress(task)) return null;
  const value = shownProgress(task);
  return (
    <div className="rounded-xl border bg-card/60 p-3" role="group" aria-label={t("progress.title")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("progress.title")}</span>
        <span className="font-display text-[1.6rem] leading-none tabular-nums">{value === null ? "—" : t("progress.percent", { value })}</span>
      </div>
      <Bar value={value} className="mt-2 h-2" />
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {value === null && <p>{t("progress.notReported")}</p>}
        {task.progressNote && task.status !== "DONE" && <p className="text-foreground">{task.progressNote}</p>}
        {task.progressDerived && task.status !== "DONE" ? (
          <p className="inline-flex items-center gap-1">
            <GitBranch className="size-3" aria-hidden /> {t("progress.derived")}
          </p>
        ) : (
          task.progressAt && task.status !== "DONE" && <p>{t("progress.reportedAgo", { when: f.ago(task.progressAt) })}</p>
        )}
      </div>
    </div>
  );
}
