"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ChevronDown, Pencil, Plus, RotateCcw, Target, Trash2, X } from "lucide-react";
import { hasRole, type TaskStatus } from "@wfos/shared";
import Link from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader, StatusBadge } from "@/components/layout/common";
import { api } from "@/lib/api";
import { goalsQueryKey, useGoals, useMe, useTeams, type Goal } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

type Form = { title: string; description: string; parentId: string; teamId: string; targetDate: string };
const BLANK: Form = { title: "", description: "", parentId: "", teamId: "", targetDate: "" };

/**
 * P1 (after Paperclip): the workspace's goals, broad ones with the goals under them. Tasks and projects serve a goal
 * (subtasks and project tasks inherit it), so each goal shows its open and done work and the credits spent on it.
 */
export default function GoalsPage() {
  const t = useTranslations("goals");
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const admin = !!me && hasRole(me.role, "ADMIN");
  const { data, isLoading } = useGoals();
  const { data: teams } = useTeams();
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const goals = useMemo(() => data?.goals ?? [], [data]);
  const shown = goals.filter((g) => showClosed || g.status === "active");
  /** the goals shown under `id` (null: the top level, with goals whose parent is hidden) */
  const childrenOf = (id: string | null) => shown.filter((g) => (id === null ? !g.parentId || !shown.some((p) => p.id === g.parentId) : g.parentId === id));
  const teamName = (id: string | null) => teams?.find((x) => x.id === id)?.name;

  const refresh = () => void qc.invalidateQueries({ queryKey: goalsQueryKey });
  const onError = (e: unknown) => toast.error((e as Error).message);
  const save = useMutation({
    mutationFn: ({ id, form }: { id: string | null; form: Form }) => {
      const b = { title: form.title, description: form.description, parentId: form.parentId || null, teamId: form.teamId || null, targetDate: form.targetDate || null };
      return id ? api.patch(`/api/goals/${id}`, b) : api.post("/api/goals", b);
    },
    onSuccess: () => {
      toast.success(t("saved"));
      setEditing(null);
      refresh();
    },
    onError,
  });
  const setStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: Goal["status"] }) => api.patch(`/api/goals/${id}`, { status }), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/goals/${id}`), onSuccess: refresh, onError });

  const edit = (g: Goal) => setEditing({ id: g.id, form: { title: g.title, description: g.description, parentId: g.parentId ?? "", teamId: g.teamId ?? "", targetDate: g.targetDate ?? "" } });
  /** the goal and every goal under it: none of them can become its parent */
  const below = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of goals)
        if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
          out.add(g.id);
          grew = true;
        }
    }
    return out;
  };

  const row = (g: Goal, depth: number) => (
    <li key={g.id} className="space-y-2">
      <div className={cn("rounded-xl border bg-card p-4", g.status !== "active" && "opacity-70")} style={{ marginLeft: depth ? `${Math.min(depth, 4) * 1.25}rem` : undefined }}>
        <div className="flex flex-wrap items-start gap-2">
          <Target className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {g.title}
              {g.status !== "active" && <span className="ml-2 rounded bg-secondary px-1.5 text-xs font-normal">{t(`status.${g.status}`)}</span>}
            </p>
            <p className="text-xs text-muted-foreground">{[teamName(g.teamId) ?? t("wholeWorkspace"), g.targetDate && t("target", { date: f.date(g.targetDate) })].filter(Boolean).join(" · ")}</p>
            {g.description && <p className="mt-1 text-sm whitespace-pre-wrap">{g.description}</p>}
          </div>
          {admin && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={t("addSub")} title={t("addSub")} onClick={() => setEditing({ id: null, form: { ...BLANK, parentId: g.id, teamId: g.teamId ?? "" } })}>
                <Plus className="size-3.5" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={t("edit")} title={t("edit")} onClick={() => edit(g)}>
                <Pencil className="size-3.5" />
              </Button>
              {g.status === "active" ? (
                <>
                  <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={t("markDone")} title={t("markDone")} onClick={() => setStatus.mutate({ id: g.id, status: "done" })}>
                    <Check className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={t("drop")} title={t("drop")} onClick={() => setStatus.mutate({ id: g.id, status: "dropped" })}>
                    <X className="size-3.5" />
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={t("reopen")} title={t("reopen")} onClick={() => setStatus.mutate({ id: g.id, status: "active" })}>
                  <RotateCcw className="size-3.5" />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-destructive"
                aria-label={t("delete")}
                title={t("delete")}
                onClick={() => confirm(t("deleteConfirm", { title: g.title })) && remove.mutate(g.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Stat label={t("stats.open")} value={String(g.total.open)} />
          <Stat label={t("stats.done")} value={String(g.total.done)} />
          <Stat label={t("stats.credits30d")} value={f.credits(g.total.credits30d)} />
          <Stat label={t("stats.credits")} value={f.credits(g.total.credits)} />
        </dl>
        {g.total.open + g.total.done > g.stats.open + g.stats.done && <p className="mt-1 text-xs text-muted-foreground">{t("includesSub")}</p>}
        {g.stats.open + g.stats.done > 0 && (
          <Button size="sm" variant="ghost" className="mt-2 h-7 gap-1 px-2 text-xs" aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
            <ChevronDown className={cn("size-3.5 transition-transform", open === g.id && "rotate-180")} aria-hidden /> {t("tasks", { count: g.stats.open + g.stats.done })}
          </Button>
        )}
        {open === g.id && <GoalTasks goalId={g.id} />}
      </div>
      {childrenOf(g.id).length > 0 && <ul className="space-y-2">{childrenOf(g.id).map((c) => row(c, depth + 1))}</ul>}
    </li>
  );

  const roots = childrenOf(null);
  const parentChoices = editing ? goals.filter((g) => !editing.id || !below(editing.id).has(g.id)) : [];
  const setForm = (patch: Partial<Form>) => editing && setEditing({ ...editing, form: { ...editing.form, ...patch } });
  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> {t("showClosed")}
            </label>
            {admin && (
              <Button className="gap-1.5" onClick={() => setEditing({ id: null, form: BLANK })}>
                <Plus className="size-4" aria-hidden /> {t("new")}
              </Button>
            )}
          </>
        }
      />
      {!!data?.withoutGoal30d && <p className="mb-4 text-sm text-muted-foreground">{t("withoutGoal", { credits: f.credits(data.withoutGoal30d) })}</p>}
      {!isLoading && !roots.length && <EmptyState icon={<Target className="size-8" />} title={t("empty")} description={admin ? t("emptyAdmin") : undefined} />}
      <ul className="space-y-3">{roots.map((g) => row(g, 0))}</ul>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("editTitle") : t("newTitle")}</DialogTitle>
          </DialogHeader>
          {editing && (
            <form
              id="goal-form"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(editing);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="goal-title">{t("field.title")}</Label>
                <Input id="goal-title" required maxLength={200} value={editing.form.title} placeholder={t("field.titlePlaceholder")} onChange={(e) => setForm({ title: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="goal-description">{t("field.description")}</Label>
                <Textarea id="goal-description" rows={3} maxLength={4000} value={editing.form.description} onChange={(e) => setForm({ description: e.target.value })} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="goal-parent">{t("field.parent")}</Label>
                  <select id="goal-parent" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={editing.form.parentId} onChange={(e) => setForm({ parentId: e.target.value })}>
                    <option value="">{t("field.noParent")}</option>
                    {parentChoices.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="goal-team">{t("field.team")}</Label>
                  <select id="goal-team" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={editing.form.teamId} onChange={(e) => setForm({ teamId: e.target.value })}>
                    <option value="">{t("wholeWorkspace")}</option>
                    {teams?.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="goal-date">{t("field.targetDate")}</Label>
                <Input id="goal-date" type="date" value={editing.form.targetDate} onChange={(e) => setForm({ targetDate: e.target.value })} />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button type="submit" form="goal-form" disabled={save.isPending}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** the goal's own top-level tasks, newest first */
function GoalTasks({ goalId }: { goalId: string }) {
  const t = useTranslations("goals");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["tasks", { goalId }],
    queryFn: () =>
      api
        .get<{ tasks: { id: string; title: string; status: TaskStatus; costCredits: number; parentTaskId: string | null }[] }>(`/api/tasks?goalId=${goalId}&limit=30`)
        .then((r) => r.tasks.filter((x) => !x.parentTaskId)),
  });
  if (!data) return null;
  if (!data.length) return <p className="mt-2 text-xs text-muted-foreground">{t("onlySubtasks")}</p>;
  return (
    <ul className="mt-2 space-y-1">
      {data.map((task) => (
        <li key={task.id}>
          <Link href={`/tasks/${task.id}`} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
            <span className="flex-1 truncate">{task.title}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{f.credits(task.costCredits)}</span>
            <StatusBadge status={task.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
