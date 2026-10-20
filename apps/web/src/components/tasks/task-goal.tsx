"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Target } from "lucide-react";
import { hasRole } from "@wfos/shared";
import { api } from "@/lib/api";
import { goalsQueryKey, useGoals, useMe } from "@/lib/hooks";

/**
 * P1: the goal a task serves, in the task's header. Members change it on a top-level task (its subtasks follow);
 * a subtask shows its parent's.
 */
export function TaskGoal({ taskId, goalId, subtask, onChanged }: { taskId: string; goalId: string | null; subtask: boolean; onChanged: () => void }) {
  const t = useTranslations("tasks");
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data } = useGoals();
  const set = useMutation({
    mutationFn: (next: string | null) => api.put(`/api/tasks/${taskId}/goal`, { goalId: next }),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: goalsQueryKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const goals = data?.goals ?? [];
  const current = goals.find((g) => g.id === goalId);
  const canEdit = !subtask && !!me && hasRole(me.role, "MEMBER");
  if (!goals.length || (!canEdit && !current)) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Target className="size-3.5" aria-hidden />
      {canEdit ? (
        <select
          aria-label={t("newTask.goal")}
          className="h-6 max-w-[16rem] rounded border bg-background px-1 text-xs"
          value={goalId ?? ""}
          disabled={set.isPending}
          onChange={(e) => set.mutate(e.target.value || null)}
        >
          <option value="">{t("newTask.noGoal")}</option>
          {goals
            .filter((g) => g.status === "active" || g.id === goalId)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.parentId ? `↳ ${g.title}` : g.title}
              </option>
            ))}
        </select>
      ) : (
        <span>{current!.title}</span>
      )}
    </span>
  );
}
