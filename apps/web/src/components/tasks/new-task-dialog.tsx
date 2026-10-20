"use client";

import { TASK_WORK_MODES, type TaskWorkMode } from "@wfos/shared";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useClients, useEmployees, useGoals, useTeams } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useDivisionSuggestion } from "@/components/dashboard/attention";

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

const EMPTY = { title: "", brief: "", assignee: "", clientId: "", projectId: "", goalId: "", repositoryId: "", dryRun: false, start: true, workMode: "standard" as TaskWorkMode, personReview: false };
/** what a quick action fills in; `assignee` is "e:<employeeId>" or "t:<teamId>". Read when the dialog mounts: give it a new `key` per prefill. */
export type NewTaskPrefill = Partial<Pick<typeof EMPTY, "title" | "brief" | "assignee" | "clientId" | "projectId" | "goalId">>;

/**
 * A new task. It goes to a division by default (its head decides how it gets done); a specific person is the
 * exception. Picking a project fills in its client and its responsible division.
 */
export function NewTaskDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: NewTaskPrefill }) {
  const qc = useQueryClient();
  const t = useTranslations("tasks");
  const tc = useTranslations("common");
  const { data: emps } = useEmployees();
  const { data: divisions } = useTeams();
  const { data: clients } = useClients();
  const { data: goalData } = useGoals();
  const [f, setF] = useState(() => ({ ...EMPTY, ...initial }));
  const activeGoals = (goalData?.goals ?? []).filter((g) => g.status === "active" || g.id === f.goalId);
  const [mode, setMode] = useState<"division" | "person">(() => (initial?.assignee?.startsWith("e:") ? "person" : "division"));
  const uid = useId();
  const { data: repos } = useQuery({ queryKey: ["repositories"], queryFn: () => api.get<{ repositories: { id: string; name: string }[] }>("/api/repositories").then((r) => r.repositories) });
  const teamId = mode === "division" && f.assignee.startsWith("t:") ? f.assignee.slice(2) : "";
  const assigneeId = mode === "person" && f.assignee.startsWith("e:") ? f.assignee.slice(2) : "";
  const division = divisions?.find((d) => d.id === teamId);
  const assignedEmployee = emps?.find((e) => e.id === assigneeId);
  // code work: a person in Workspace mode, or a division whose code lead builds in a sandbox
  const codeWork = assignedEmployee?.executionMode === "workspace" || !!division?.codeLeadId;
  const allProjects = (clients ?? []).flatMap((c) => c.projects.map((p) => ({ ...p, clientName: c.code || c.name })));
  const projects = f.clientId ? allProjects.filter((p) => p.clientId === f.clientId) : allProjects;
  const pickProject = (projectId: string) => {
    const p = allProjects.find((x) => x.id === projectId);
    if (!p) return setF({ ...f, projectId: "" });
    // the project fixes the client; its division takes the work unless a person was chosen on purpose
    setF({ ...f, projectId, clientId: p.clientId, ...(p.teamId && mode === "division" ? { assignee: `t:${p.teamId}` } : {}) });
  };
  const m = useMutation({
    mutationFn: () =>
      api.post("/api/tasks", {
        title: f.title,
        brief: f.brief,
        assigneeId: assigneeId || null,
        teamId: teamId || null,
        clientId: f.clientId || null,
        projectId: f.projectId || null,
        // none chosen: the project's goal (if any)
        goalId: f.goalId || undefined,
        workMode: f.workMode,
        reviewPolicy: f.personReview ? "person" : "auto",
        repositoryId: codeWork && f.workMode === "standard" && f.repositoryId ? f.repositoryId : null,
        dryRun: f.dryRun,
        start: f.start,
      }),
    onSuccess: () => {
      toast.success(t("newTask.created"));
      onOpenChange(false);
      setF(EMPTY);
      setMode("division");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["teams"] });
      // the client's page lists its tasks
      if (f.clientId) void qc.invalidateQueries({ queryKey: ["client", f.clientId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // a project with a responsible division can go without an explicit target: the server routes it there
  const projectDivision = allProjects.find((p) => p.id === f.projectId)?.teamId ?? null;
  // nothing chosen yet: the division the words point to (shown with its words; a pick of the person wins)
  const suggestion = useDivisionSuggestion(`${f.title}\n${f.brief}`, mode === "division" && !f.assignee && !projectDivision);
  const ready = !!f.title && (!!teamId || !!assigneeId || (mode === "division" && !!projectDivision));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("newTask.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-title`}>{t("newTask.fieldTitle")}</Label>
            <Input id={`${uid}-title`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-brief`}>{t("newTask.brief")}</Label>
            <Textarea id={`${uid}-brief`} rows={5} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} />
          </div>

          <fieldset className="space-y-2 rounded-xl border p-3">
            <legend className="px-1 text-sm font-medium">{t("newTask.assignTo")}</legend>
            {mode === "division" ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-division`} className="sr-only">
                  {t("newTask.division")}
                </Label>
                <select id={`${uid}-division`} className={sel} value={teamId ? `t:${teamId}` : ""} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
                  <option value="">{projectDivision ? t("newTask.projectDivision") : tc("selectPlaceholder")}</option>
                  {divisions?.map((d) => (
                    <option key={d.id} value={`t:${d.id}`} disabled={!d.leadId}>
                      {d.leadId ? d.name : t("newTask.divisionNoHead", { name: d.name })}
                    </option>
                  ))}
                </select>
                {suggestion && !f.assignee && (
                  <p className="text-xs">
                    {t("newTask.suggested", { name: suggestion.name, words: suggestion.matched.join(", ") })}{" "}
                    <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => setF({ ...f, assignee: `t:${suggestion.id}` })}>
                      {t("newTask.useSuggestion")}
                    </button>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{t("newTask.divisionHelp")}</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-person`} className="sr-only">
                  {t("newTask.person")}
                </Label>
                <select id={`${uid}-person`} className={sel} value={assigneeId ? `e:${assigneeId}` : ""} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
                  <option value="">{tc("selectPlaceholder")}</option>
                  {emps
                    ?.filter((e) => e.status !== "ARCHIVED")
                    .map((e) => (
                      <option key={e.id} value={`e:${e.id}`}>
                        {e.name} — {e.role}
                        {e.division ? ` · ${e.division.name}` : ""}
                      </option>
                    ))}
                </select>
              </div>
            )}
            <button
              type="button"
              className={cn("text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline")}
              onClick={() => {
                setMode(mode === "division" ? "person" : "division");
                setF({ ...f, assignee: "" });
              }}
            >
              {mode === "division" ? t("newTask.toPerson") : t("newTask.toDivision")}
            </button>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-client`}>{t("newTask.client")}</Label>
              <select
                id={`${uid}-client`}
                className={sel}
                value={f.clientId}
                onChange={(e) => setF({ ...f, clientId: e.target.value, projectId: allProjects.find((p) => p.id === f.projectId)?.clientId === e.target.value ? f.projectId : "" })}
              >
                <option value="">—</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code ? `${c.code} · ${c.name}` : c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-project`}>{t("newTask.project")}</Label>
              <select id={`${uid}-project`} className={sel} value={f.projectId} onChange={(e) => pickProject(e.target.value)} disabled={!projects.length}>
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {f.clientId ? p.name : `${p.clientName} · ${p.name}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!!activeGoals.length && (
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-goal`}>{t("newTask.goal")}</Label>
              <select id={`${uid}-goal`} className={sel} value={f.goalId} onChange={(e) => setF({ ...f, goalId: e.target.value })}>
                <option value="">{f.projectId ? t("newTask.goalFromProject") : "—"}</option>
                {activeGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.parentId ? `↳ ${g.title}` : g.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-mode`}>{t("newTask.workMode")}</Label>
            <select id={`${uid}-mode`} className={sel} value={f.workMode} onChange={(e) => setF({ ...f, workMode: e.target.value as TaskWorkMode })}>
              {TASK_WORK_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`newTask.workModes.${m}`)}
                </option>
              ))}
            </select>
            {f.workMode !== "standard" && <p className="text-xs text-muted-foreground">{t(`newTask.workModeHelp.${f.workMode}`)}</p>}
          </div>
          {codeWork && f.workMode === "standard" && (
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-repository`}>{t("newTask.repository")}</Label>
              <select id={`${uid}-repository`} className={sel} value={f.repositoryId} onChange={(e) => setF({ ...f, repositoryId: e.target.value })}>
                <option value="">{t("newTask.noRepository")}</option>
                {repos?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t("newTask.repositoryHelp")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.dryRun} onChange={(e) => setF({ ...f, dryRun: e.target.checked })} /> {t("newTask.dryRun")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.personReview} onChange={(e) => setF({ ...f, personReview: e.target.checked })} /> {t("newTask.personReview")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.start} onChange={(e) => setF({ ...f, start: e.target.checked })} /> {t("newTask.startImmediately")}
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!ready || m.isPending}>
            {t("newTask.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
