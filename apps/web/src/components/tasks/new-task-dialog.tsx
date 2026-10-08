"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useClients, useEmployees, useTeams } from "@/lib/hooks";

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const t = useTranslations("tasks");
  const tc = useTranslations("common");
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const { data: clients } = useClients();
  const [f, setF] = useState({ title: "", brief: "", assignee: "", clientId: "", projectId: "", repositoryId: "", dryRun: false, start: true });
  const { data: repos } = useQuery({ queryKey: ["repositories"], queryFn: () => api.get<{ repositories: { id: string; name: string }[] }>("/api/repositories").then((r) => r.repositories) });
  const assignedEmployee = f.assignee.startsWith("e:") ? emps?.find((e) => e.id === f.assignee.slice(2)) : undefined;
  const workspaceMode = assignedEmployee?.executionMode === "workspace";
  const projects = clients?.find((c) => c.id === f.clientId)?.projects ?? [];
  const m = useMutation({
    mutationFn: () => {
      const [kind, id] = f.assignee.split(":");
      return api.post("/api/tasks", {
        title: f.title,
        brief: f.brief,
        assigneeId: kind === "e" ? id : null,
        teamId: kind === "t" ? id : null,
        clientId: f.clientId || null,
        projectId: f.projectId || null,
        repositoryId: workspaceMode && f.repositoryId ? f.repositoryId : null,
        dryRun: f.dryRun,
        start: f.start,
      });
    },
    onSuccess: () => {
      toast.success(t("newTask.created"));
      onOpenChange(false);
      setF({ title: "", brief: "", assignee: "", clientId: "", projectId: "", repositoryId: "", dryRun: false, start: true });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("newTask.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("newTask.fieldTitle")}</Label>
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("newTask.brief")}</Label>
            <Textarea rows={5} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("newTask.assignTo")}</Label>
            <select className={sel} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">{tc("selectPlaceholder")}</option>
              <optgroup label={t("newTask.employees")}>
                {emps
                  ?.filter((e) => e.status !== "ARCHIVED")
                  .map((e) => (
                    <option key={e.id} value={`e:${e.id}`}>
                      {e.avatar} {e.name} — {e.role}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={t("newTask.teams")}>
                {teams
                  ?.filter((team) => team.leadId)
                  .map((team) => (
                    <option key={team.id} value={`t:${team.id}`}>
                      👥 {team.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("newTask.client")}</Label>
              <select className={sel} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value, projectId: "" })}>
                <option value="">—</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("newTask.project")}</Label>
              <select className={sel} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} disabled={!projects.length}>
                <option value="">—</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {workspaceMode && (
            <div className="space-y-1.5">
              <Label htmlFor="task-repository">{t("newTask.repository")}</Label>
              <select id="task-repository" className={sel} value={f.repositoryId} onChange={(e) => setF({ ...f, repositoryId: e.target.value })}>
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
              <input type="checkbox" checked={f.start} onChange={(e) => setF({ ...f, start: e.target.checked })} /> {t("newTask.startImmediately")}
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!f.title || !f.assignee || m.isPending}>
            {t("newTask.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
