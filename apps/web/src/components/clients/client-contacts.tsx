"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Plus, Trash2, UserRound } from "lucide-react";
import { CONTACT_RECEIVES, CONTACT_ROLES, type ClientContact } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/layout/common";
import { api } from "@/lib/api";
import { invalidateClient, selectClass, useClientRights } from "./shared";

const EMPTY: ClientContact = { name: "", email: "", role: "", phone: "", receives: { status: false, minutes: false, invoice: false } };
const KNOWN_ROLES: readonly string[] = CONTACT_ROLES;

function ContactCard({ c, onChange, onRemove, disabled }: { c: ClientContact; onChange: (c: ClientContact) => void; onRemove: () => void; disabled: boolean }) {
  const t = useTranslations("clients");
  const uid = useId();
  const set = (patch: Partial<ClientContact>) => onChange({ ...c, ...patch });
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-name`}>{t("form.contactName")}</Label>
          <Input id={`${uid}-name`} value={c.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-role`}>{t("form.contactRole")}</Label>
          <select id={`${uid}-role`} className={selectClass} value={c.role} disabled={disabled} onChange={(e) => set({ role: e.target.value })}>
            <option value="">—</option>
            {CONTACT_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`contacts.role.${r}`)}
              </option>
            ))}
            {/* a role typed before the list existed stays selectable as it was written */}
            {c.role && !KNOWN_ROLES.includes(c.role) && <option value={c.role}>{c.role}</option>}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-email`}>{t("form.contactEmail")}</Label>
          <Input id={`${uid}-email`} type="email" value={c.email} disabled={disabled} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-phone`}>{t("form.phone")}</Label>
          <Input id={`${uid}-phone`} type="tel" value={c.phone} disabled={disabled} onChange={(e) => set({ phone: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">{t("contacts.receives")}</legend>
          <span className="text-xs text-muted-foreground" aria-hidden>
            {t("contacts.receives")}
          </span>
          {CONTACT_RECEIVES.map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={c.receives[k]} disabled={disabled} onChange={(e) => set({ receives: { ...c.receives, [k]: e.target.checked } })} />
              {t(`contacts.receive.${k}`)}
            </label>
          ))}
        </fieldset>
        {!disabled && (
          <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" onClick={onRemove}>
            <Trash2 className="size-3.5" /> {t("form.removeContact")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The Contacts tab: who to talk to, and which mail (status reports, minutes, invoices) each person should get. */
export function ClientContacts({ clientId, contacts }: { clientId: string; contacts: ClientContact[] }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { canEdit } = useClientRights();
  const [list, setList] = useState<ClientContact[]>(contacts);
  const dirty = JSON.stringify(list) !== JSON.stringify(contacts);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/clients/${clientId}`, { contacts: list.filter((c) => c.name || c.email) }),
    onSuccess: () => (toast.success(tc("saved")), invalidateClient(qc, clientId)),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("contacts.help")}</p>
      {!list.length && <EmptyState icon={<UserRound className="size-7" />} title={t("contacts.empty")} />}
      {list.map((c, i) => (
        <ContactCard
          key={i}
          c={c}
          disabled={!canEdit}
          onChange={(v) => setList(list.map((x, j) => (j === i ? v : x)))}
          onRemove={() => setList(list.filter((_, j) => j !== i))}
        />
      ))}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="gap-1" onClick={() => setList([...list, { ...EMPTY, receives: { ...EMPTY.receives } }])}>
            <Plus className="size-3.5" /> {t("form.addContact")}
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? tc("saving") : tc("save")}
          </Button>
        </div>
      )}
    </div>
  );
}
