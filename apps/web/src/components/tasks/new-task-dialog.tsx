"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const { data: clients } = useClients();
  const [f, setF] = useState({ title: "", brief: "", assignee: "", clientId: "", projectId: "", dryRun: false, start: true });
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
        dryRun: f.dryRun,
        start: f.start,
      });
    },
    onSuccess: () => {
      toast.success("Task created");
      onOpenChange(false);
      setF({ title: "", brief: "", assignee: "", clientId: "", projectId: "", dryRun: false, start: true });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Brief</Label>
            <Textarea rows={5} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Assign to</Label>
            <select className={sel} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">Choose…</option>
              <optgroup label="Employees">
                {emps
                  ?.filter((e) => e.status !== "ARCHIVED")
                  .map((e) => (
                    <option key={e.id} value={`e:${e.id}`}>
                      {e.avatar} {e.name} — {e.role}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Teams (Lead plans & delegates)">
                {teams
                  ?.filter((t) => t.leadId)
                  .map((t) => (
                    <option key={t.id} value={`t:${t.id}`}>
                      👥 {t.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Client</Label>
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
              <Label>Project</Label>
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
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.dryRun} onChange={(e) => setF({ ...f, dryRun: e.target.checked })} /> Dry run
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.start} onChange={(e) => setF({ ...f, start: e.target.checked })} /> Start immediately
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!f.title || !f.assignee || m.isPending}>
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
