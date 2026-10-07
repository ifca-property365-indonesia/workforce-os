"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Crown, GripVertical, Plus, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState, PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useClients, useEmployees, useTeams, type Team } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function BriefDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const { data: clients } = useClients();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [dryRun, setDryRun] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post<{ task: { id: string } }>("/api/tasks", { title, brief, teamId: team.id, clientId: clientId || null, dryRun }),
    onSuccess: (r) => (location.href = `/tasks/${r.task.id}`),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Brief the {team.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Brief</Label>
            <Textarea rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="The Lead will plan, delegate subtasks to members and review their deliverables." />
          </div>
          <div className="space-y-1.5">
            <Label>Client (optional)</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">—</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run
          </label>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!title || m.isPending}>
            Send brief
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TeamsPage() {
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const [newName, setNewName] = useState("");
  const [over, setOver] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Team | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["teams"] });
  const create = useMutation({ mutationFn: () => api.post("/api/teams", { name: newName, leadId: null, memberIds: [] }), onSuccess: () => (setNewName(""), inv()) });
  const update = useMutation({
    mutationFn: (v: { id: string; leadId?: string | null; memberIds?: string[] }) => api.patch(`/api/teams/${v.id}`, v),
    onSuccess: inv,
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/teams/${id}`), onSuccess: inv });
  const active = emps?.filter((e) => e.status !== "ARCHIVED") ?? [];
  const byId = new Map(active.map((e) => [e.id, e]));

  return (
    <div>
      <PageHeader title="Teams" description="Drag employees into a team and crown a Lead. The Lead plans, delegates subtasks and reviews deliverables." />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Employees</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {active.map((e) => (
              <div
                key={e.id}
                draggable
                onDragStart={(ev) => ev.dataTransfer.setData("text/employee", e.id)}
                className="flex cursor-grab items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm active:cursor-grabbing"
              >
                <GripVertical className="size-3.5 text-muted-foreground" />
                <Avatar emoji={e.avatar} size="sm" />
                <span className="flex-1 truncate">{e.name}</span>
                <span className="text-xs text-muted-foreground">{e.role}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input placeholder="New team name" value={newName} onChange={(e) => setNewName(e.target.value)} className="max-w-xs" />
            <Button disabled={!newName} onClick={() => create.mutate()} className="gap-1">
              <Plus className="size-4" /> Create team
            </Button>
          </div>
          {!teams?.length && <EmptyState title="No teams yet" description="Create a team, then drag employees into it." />}
          {teams?.map((t) => (
            <Card
              key={t.id}
              onDragOver={(ev) => {
                ev.preventDefault();
                setOver(t.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(ev) => {
                ev.preventDefault();
                setOver(null);
                const id = ev.dataTransfer.getData("text/employee");
                if (id && !t.memberIds.includes(id)) update.mutate({ id: t.id, memberIds: [...t.memberIds, id] });
              }}
              className={cn("transition", over === t.id && "ring-2 ring-primary")}
            >
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">{t.name}</CardTitle>
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" disabled={!t.leadId} onClick={() => setBriefing(t)} className="gap-1">
                    <Send className="size-3.5" /> Brief team
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => confirm(`Delete ${t.name}?`) && del.mutate(t.id)} aria-label="Delete team">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!t.memberIds.length && <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">Drop employees here</p>}
                <div className="flex flex-wrap gap-2">
                  {t.memberIds.map((id) => {
                    const e = byId.get(id);
                    if (!e) return null;
                    const lead = t.leadId === id;
                    return (
                      <div key={id} className={cn("flex items-center gap-2 rounded-full border py-1 pl-1 pr-2 text-sm", lead && "border-amber-500 bg-amber-500/10")}>
                        <Avatar emoji={e.avatar} size="sm" />
                        {e.name}
                        <button type="button" title={lead ? "Lead" : "Make Lead"} onClick={() => update.mutate({ id: t.id, leadId: id })} className={lead ? "text-amber-600" : "text-muted-foreground hover:text-amber-600"}>
                          <Crown className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Remove"
                          onClick={() => update.mutate({ id: t.id, memberIds: t.memberIds.filter((m) => m !== id), ...(lead ? { leadId: null } : {}) })}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {!t.leadId && t.memberIds.length > 0 && <p className="mt-2 text-xs text-amber-600">Click the crown to choose a Lead.</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      {briefing && <BriefDialog team={briefing} onClose={() => setBriefing(null)} />}
    </div>
  );
}
