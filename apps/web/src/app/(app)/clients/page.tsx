"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Building2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useClients, type Client } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";

type CForm = { name: string; email: string; contacts: { name: string; email: string; role: string }[]; notes: string; currency: string };

function ClientDialog({ client, onClose }: { client?: Client; onClose: () => void }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const [f, setF] = useState<CForm>(client ? { name: client.name, email: client.email, contacts: client.contacts, notes: client.notes, currency: client.currency } : { name: "", email: "", contacts: [], notes: "", currency: "IDR" });
  const m = useMutation({
    mutationFn: () => (client ? api.patch(`/api/clients/${client.id}`, f) : api.post("/api/clients", f)),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ["clients"] }), onClose()),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{client ? t("editClient") : t("newClient")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>{tc("name")}</Label>
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("form.currency")}</Label>
              <Input value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("form.email")}</Label>
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("form.contacts")}</Label>
            {f.contacts.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                <Input placeholder={t("form.contactName")} value={c.name} onChange={(e) => setF({ ...f, contacts: f.contacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input placeholder={t("form.contactEmail")} value={c.email} onChange={(e) => setF({ ...f, contacts: f.contacts.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })} />
                <Input placeholder={t("form.contactRole")} value={c.role} onChange={(e) => setF({ ...f, contacts: f.contacts.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} />
                <Button variant="ghost" size="icon" onClick={() => setF({ ...f, contacts: f.contacts.filter((_, j) => j !== i) })} aria-label={t("form.removeContact")}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setF({ ...f, contacts: [...f.contacts, { name: "", email: "", role: "" }] })}>
              {t("form.addContact")}
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label>{t("form.notes")}</Label>
            <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!f.name || m.isPending}>
            {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({ p, currency }: { p: Client["projects"][number]; currency: string }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const qc = useQueryClient();
  const del = useMutation({ mutationFn: () => api.del(`/api/projects/${p.id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }) });
  return (
    <div className="flex items-start gap-2 rounded-md border p-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {p.name} <span className="ml-1 rounded bg-muted px-1.5 text-[11px]">{t.has(`project.status.${p.status}`) ? t(`project.status.${p.status}`) : p.status}</span>
        </div>
        <div className="text-xs text-muted-foreground">{p.description}</div>
        <div className="text-xs text-muted-foreground">{t("project.rate", { rate: f.money(p.hourlyRate, currency) })}</div>
      </div>
      <Link href={`/tasks?projectId=${p.id}`} className="text-xs text-primary hover:underline">
        {t("project.tasks")}
      </Link>
      <button type="button" onClick={() => confirm(t("project.confirmDelete", { name: p.name })) && del.mutate()} aria-label={t("project.delete")}>
        <Trash2 className="size-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}

function AddProject({ clientId }: { clientId: string }) {
  const t = useTranslations("clients");
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", description: "", hourlyRate: 0 });
  const [open, setOpen] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post("/api/projects", { ...f, clientId }),
    onSuccess: () => (setF({ name: "", description: "", hourlyRate: 0 }), setOpen(false), void qc.invalidateQueries({ queryKey: ["clients"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!open)
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Plus className="size-3.5" /> {t("project.add")}
      </Button>
    );
  return (
    <div className="space-y-2 rounded-md border p-2">
      <Input placeholder={t("project.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <Textarea placeholder={t("project.descriptionPlaceholder")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <Input type="number" placeholder={t("project.hourlyRatePlaceholder")} value={f.hourlyRate || ""} onChange={(e) => setF({ ...f, hourlyRate: Number(e.target.value) })} />
      <Button size="sm" onClick={() => m.mutate()} disabled={!f.name}>
        {t("project.addProject")}
      </Button>
    </div>
  );
}

export default function ClientsPage() {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data } = useClients();
  const [edit, setEdit] = useState<{ client?: Client } | null>(null);
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/clients/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }) });
  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setEdit({})} className="gap-1.5">
            <Plus className="size-4" /> {t("newClient")}
          </Button>
        }
      />
      {!data?.length && <EmptyState icon={<Building2 className="size-8" />} title={t("empty")} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((c) => (
          <Card key={c.id}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{c.name}</CardTitle>
                <div className="text-xs text-muted-foreground">
                  {c.email || t("noEmail")} · {c.currency} · {t("idLabel")} <code className="text-[10px]">{c.id.slice(0, 8)}</code>
                </div>
              </div>
              <div className="flex">
                <Button size="icon" variant="ghost" onClick={() => setEdit({ client: c })} aria-label={tc("edit")}>
                  <Pencil className="size-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => confirm(t("confirmDelete", { name: c.name })) && del.mutate(c.id)} aria-label={tc("delete")}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!!c.contacts.length && (
                <div className="space-y-0.5">
                  {c.contacts.map((x) => (
                    <div key={x.email + x.name} className="text-xs">
                      <span className="font-medium">{x.name}</span> {`<${x.email}>`} <span className="text-muted-foreground">{x.role}</span>
                    </div>
                  ))}
                </div>
              )}
              {c.notes && <p className="text-xs text-muted-foreground">{c.notes}</p>}
              <div className="space-y-2">
                {c.projects.map((p) => (
                  <ProjectRow key={p.id} p={p} currency={c.currency} />
                ))}
                <AddProject clientId={c.id} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {edit && <ClientDialog client={edit.client} onClose={() => setEdit(null)} />}
    </div>
  );
}
