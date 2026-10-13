"use client";

import { useId, useState, type ComponentProps } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { CLIENT_STATUSES, type ClientStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useRouter } from "@/lib/nav";
import type { ClientSummary } from "@/lib/hooks";
import { invalidateClient, selectClass, useClientRights } from "./shared";

type Form = Pick<ClientSummary, "name" | "legalName" | "status" | "currency" | "email" | "phone" | "taxId" | "address" | "notes">;

const pick = (c: ClientSummary): Form => ({
  name: c.name,
  legalName: c.legalName,
  status: c.status,
  currency: c.currency,
  email: c.email,
  phone: c.phone,
  taxId: c.taxId,
  address: c.address,
  notes: c.notes,
});

/** The Info tab: the client's profile as printed on invoices, and the notes employees read. */
export function ClientInfo({ client }: { client: ClientSummary }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const router = useRouter();
  const uid = useId();
  const { canEdit, admin } = useClientRights();
  const [f, setF] = useState<Form>(() => pick(client));
  const dirty = JSON.stringify(f) !== JSON.stringify(pick(client));
  const save = useMutation({
    mutationFn: () => api.patch(`/api/clients/${client.id}`, f),
    onSuccess: () => (toast.success(tc("saved")), invalidateClient(qc, client.id)),
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/clients/${client.id}`),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ["clients"] }), router.push("/clients")),
    onError: (e) => toast.error((e as Error).message),
  });
  const field = (k: keyof Form, label: string, props: ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${uid}-${k}`}>{label}</Label>
      <Input id={`${uid}-${k}`} value={f[k]} disabled={!canEdit} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </div>
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field("name", tc("name"))}
        {field("legalName", t("form.legalName"), { placeholder: t("form.legalNamePlaceholder") })}
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-status`}>{tc("status")}</Label>
          <select id={`${uid}-status`} className={selectClass} value={f.status} disabled={!canEdit} onChange={(e) => setF({ ...f, status: e.target.value as ClientStatus })}>
            {CLIENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {field("currency", t("form.currency"), { onChange: (e) => setF({ ...f, currency: e.target.value.toUpperCase() }), maxLength: 3 })}
        {field("email", t("form.email"), { type: "email" })}
        {field("phone", t("form.phone"), { type: "tel" })}
        {field("taxId", t("form.taxId"))}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${uid}-address`}>{t("form.address")}</Label>
          <Textarea id={`${uid}-address`} rows={3} value={f.address} disabled={!canEdit} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${uid}-notes`}>{t("form.notes")}</Label>
          <Textarea id={`${uid}-notes`} rows={4} value={f.notes} disabled={!canEdit} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {canEdit && (
          <Button type="submit" disabled={!f.name || !dirty || save.isPending}>
            {save.isPending ? tc("saving") : tc("save")}
          </Button>
        )}
        {admin && (
          <Button type="button" variant="ghost" className="gap-1.5 text-destructive" onClick={() => confirm(t("confirmDelete", { name: client.name })) && del.mutate()}>
            <Trash2 className="size-4" /> {t("deleteClient")}
          </Button>
        )}
      </div>
    </form>
  );
}
