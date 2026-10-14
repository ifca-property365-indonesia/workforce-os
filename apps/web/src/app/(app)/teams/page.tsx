"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { GripVertical, Network, Plus } from "lucide-react";
import { hasRole } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState, PageHeader } from "@/components/layout/common";
import { DivisionCard } from "@/components/divisions/division-card";
import { DivisionDialog } from "@/components/divisions/division-dialog";
import { useBotMoods } from "@/components/office/employee-sign";
import { ExportButton } from "@/components/packages/export-dialog";
import { ImportButton } from "@/components/packages/import-dialog";
import { api } from "@/lib/api";
import { useClients, useEmployees, useMe, useTeams, type Team } from "@/lib/hooks";

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
                  {c.code ? `${c.code} · ${c.name}` : c.name}
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

/**
 * Divisions (Divisi): the organisation as an org chart, one card per division in its sign colour. Work goes to a
 * division; its head does it or hands parts to members, and the code lead builds with the subagents in one sandbox.
 */
export default function DivisionsPage() {
  const t = useTranslations("teams");
  const tp = useTranslations("packages");
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const { data: divisions, isLoading } = useTeams();
  const { data: me } = useMe();
  const moods = useBotMoods();
  const admin = !!me && hasRole(me.role, "ADMIN");
  const [briefing, setBriefing] = useState<Team | null>(null);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/teams/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["teams"] });
      void qc.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const active = (emps ?? []).filter((e) => e.status !== "ARCHIVED");
  const byId = new Map(active.map((e) => [e.id, e]));
  const unassigned = active.filter((e) => !e.division);
  const nextOrder = Math.max(0, ...(divisions ?? []).map((d) => d.sortOrder + 1));

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          admin && (
            <>
              <ImportButton />
              <ExportButton label={tp("export.exportAll")} />
              <Button onClick={() => setEditing("new")} className="gap-1.5">
                <Plus className="size-4" /> {t("newDivision")}
              </Button>
            </>
          )
        }
      />
      {!admin && me && <p className="-mt-3 mb-4 text-xs text-muted-foreground">{t("viewerNote")}</p>}

      {admin && unassigned.length > 0 && (
        <section aria-labelledby="unassigned-title" className="mb-5 rounded-2xl border border-dashed bg-card/40 p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="unassigned-title" className="text-sm font-semibold">
              {t("unassigned.title")} <span className="tabular-nums text-muted-foreground">{unassigned.length}</span>
            </h2>
            <p className="text-xs text-muted-foreground">{t("unassigned.help")}</p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {unassigned.map((e) => (
              <li
                key={e.id}
                draggable
                onDragStart={(ev) => ev.dataTransfer.setData("text/employee", e.id)}
                className="flex cursor-grab items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-sm active:cursor-grabbing"
              >
                <GripVertical className="size-3.5 text-muted-foreground" aria-hidden />
                <Avatar id={e.id} size="sm" mood={moods.get(e.id)} />
                <span className="font-medium">{e.name}</span>
                <span className="text-xs text-muted-foreground">{e.role}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isLoading && !divisions?.length && (
        <EmptyState
          icon={<Network className="size-8" />}
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            admin && (
              <Button onClick={() => setEditing("new")} className="gap-1.5">
                <Plus className="size-4" /> {t("newDivision")}
              </Button>
            )
          }
        />
      )}

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 2xl:grid-cols-3">
        {divisions?.map((d) => (
          <DivisionCard
            key={d.id}
            d={d}
            byId={byId}
            employees={active}
            moods={moods}
            admin={admin}
            onBrief={() => setBriefing(d)}
            onEdit={() => setEditing(d)}
            onDelete={() => confirm(t("confirmDelete", { name: d.name })) && del.mutate(d.id)}
          />
        ))}
      </div>
      {briefing && <BriefDialog team={briefing} onClose={() => setBriefing(null)} />}
      {editing && <DivisionDialog division={editing === "new" ? undefined : editing} nextOrder={nextOrder} onClose={() => setEditing(null)} />}
    </div>
  );
}
