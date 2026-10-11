"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Crown, GripVertical, Plus, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState, PageHeader } from "@/components/layout/common";
import { useSignColors } from "@/components/office/employee-sign";
import { api } from "@/lib/api";
import { hasRole, TEAM_RESPONDER_MODES, type TeamResponderMode } from "@wfos/shared";
import { useClients, useEmployees, useMe, useTeams, type Team } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { ExportButton } from "@/components/packages/export-dialog";
import { ImportButton } from "@/components/packages/import-dialog";

function BriefDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const t = useTranslations("teams");
  const { data: clients } = useClients();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [dryRun, setDryRun] = useState(false);
  const uid = useId();
  const m = useMutation({
    mutationFn: () => api.post<{ task: { id: string } }>("/api/tasks", { title, brief, teamId: team.id, clientId: clientId || null, dryRun }),
    onSuccess: (r) => (location.href = `/tasks/${r.task.id}`),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("brief.title", { team: team.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-title`}>{t("brief.titleLabel")}</Label>
            <Input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-brief`}>{t("brief.brief")}</Label>
            <Textarea id={`${uid}-brief`} rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={t("brief.briefPlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-client`}>{t("brief.client")}</Label>
            <select id={`${uid}-client`} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">—</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> {t("brief.dryRun")}
          </label>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!title || m.isPending}>
            {t("brief.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who answers an un-mentioned message in this team's chat. */
function ResponderModePicker({ team, canEdit, saving, onChange }: { team: Team; canEdit: boolean; saving: boolean; onChange: (mode: TeamResponderMode) => void }) {
  const t = useTranslations("teams");
  const name = useId();
  return (
    <div className="mt-4 border-t pt-3">
      <div id={`${name}-title`} className="text-xs font-medium">
        {t("responder.title")}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("responder.help")} {canEdit ? null : t("responder.adminOnly")}
      </p>
      {/* aria-busy rather than disabled while saving: disabling would drop the keyboard focus from the group */}
      <div role="radiogroup" aria-labelledby={`${name}-title`} aria-busy={saving} className="grid gap-1.5 sm:grid-cols-2">
        {TEAM_RESPONDER_MODES.map((mode) => {
          const checked = (team.responderMode ?? "lead") === mode;
          return (
            <label
              key={mode}
              className={cn(
                "flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-80",
                checked ? "border-primary bg-primary/5" : canEdit && "hover:bg-accent",
              )}
            >
              <input type="radio" name={name} value={mode} checked={checked} disabled={!canEdit} onChange={() => !saving && onChange(mode)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block font-medium">{t(`responder.modes.${mode}.label`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`responder.modes.${mode}.description`)}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export default function TeamsPage() {
  const tt = useTranslations("teams");
  const tp = useTranslations("packages");
  const colors = useSignColors();
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const { data: me } = useMe();
  const isAdmin = !!me && hasRole(me.role, "ADMIN");
  const [newName, setNewName] = useState("");
  const [over, setOver] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Team | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["teams"] });
  const create = useMutation({ mutationFn: () => api.post("/api/teams", { name: newName, leadId: null, memberIds: [] }), onSuccess: () => (setNewName(""), inv()) });
  const update = useMutation({
    mutationFn: ({ id, ...v }: { id: string; leadId?: string | null; memberIds?: string[]; responderMode?: TeamResponderMode }) => api.patch(`/api/teams/${id}`, v),
    onSuccess: inv,
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/teams/${id}`), onSuccess: inv });
  const active = emps?.filter((e) => e.status !== "ARCHIVED") ?? [];
  const byId = new Map(active.map((e) => [e.id, e]));

  return (
    <div>
      <PageHeader title={tt("title")} description={tt("description")} />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{tt("employees")}</CardTitle>
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
                <Avatar emoji={e.avatar} size="sm" color={colors.get(e.id)} />
                <span className="flex-1 truncate">{e.name}</span>
                <span className="text-xs text-muted-foreground">{e.role}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input placeholder={tt("newTeamPlaceholder")} value={newName} onChange={(e) => setNewName(e.target.value)} className="max-w-xs" />
            <Button disabled={!newName} onClick={() => create.mutate()} className="gap-1">
              <Plus className="size-4" /> {tt("createTeam")}
            </Button>
            {isAdmin && (
              <div className="ml-auto flex gap-2">
                <ImportButton />
                <ExportButton label={tp("export.exportAll")} />
              </div>
            )}
          </div>
          {!teams?.length && <EmptyState title={tt("empty.title")} description={tt("empty.description")} />}
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
                    <Send className="size-3.5" /> {tt("briefTeam")}
                  </Button>
                  {isAdmin && <ExportButton selection={{ teamIds: [t.id] }} name={t.name} variant="ghost" />}
                  <Button size="icon" variant="ghost" onClick={() => confirm(tt("confirmDelete", { name: t.name })) && del.mutate(t.id)} aria-label={tt("deleteTeam")}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!t.memberIds.length && <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">{tt("dropHere")}</p>}
                <div className="flex flex-wrap gap-2">
                  {t.memberIds.map((id) => {
                    const e = byId.get(id);
                    if (!e) return null;
                    const lead = t.leadId === id;
                    return (
                      <div key={id} className={cn("flex items-center gap-2 rounded-full border py-1 pl-1 pr-2 text-sm", lead && "border-approval bg-warning/10")}>
                        <Avatar emoji={e.avatar} size="sm" color={colors.get(e.id)} />
                        {e.name}
                        <button type="button" title={lead ? tt("lead") : tt("makeLead")} onClick={() => update.mutate({ id: t.id, leadId: id })} className={lead ? "text-warning" : "text-muted-foreground hover:text-warning"}>
                          <Crown className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={tt("removeMember")}
                          onClick={() => update.mutate({ id: t.id, memberIds: t.memberIds.filter((m) => m !== id), ...(lead ? { leadId: null } : {}) })}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {!t.leadId && t.memberIds.length > 0 && <p className="mt-2 text-xs text-warning">{tt("chooseLead")}</p>}
                <ResponderModePicker
                  team={t}
                  canEdit={isAdmin}
                  saving={update.isPending && update.variables?.id === t.id && update.variables.responderMode !== undefined}
                  onChange={(responderMode) => update.mutate({ id: t.id, responderMode }, { onSuccess: () => toast.success(tt("responder.saved")) })}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      {briefing && <BriefDialog team={briefing} onClose={() => setBriefing(null)} />}
    </div>
  );
}
