"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { CLIENT_STATUSES, type ClientStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useRouter } from "@/lib/nav";
import { clientCode, selectClass } from "./shared";

/** The essentials of a new client; contacts, billing and the rest are filled in on its page, which opens next. */
export function NewClientDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const router = useRouter();
  const uid = useId();
  const [f, setF] = useState({ name: "", code: "", industry: "", website: "", legalName: "", email: "", currency: "IDR", status: "active" as ClientStatus });
  const m = useMutation({
    mutationFn: () => api.post<{ client: { id: string } }>("/api/clients", f),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["clients"] });
      onClose();
      router.push(`/clients/${r.client.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("newClient")}</DialogTitle>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name) m.mutate();
          }}
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-name`}>{tc("name")}</Label>
            <Input id={`${uid}-name`} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-code`}>{t("form.code")}</Label>
            <Input id={`${uid}-code`} value={f.code} maxLength={12} pattern="[A-Z0-9][A-Z0-9\-]{1,11}" className="font-mono uppercase" placeholder={t("form.codePlaceholder")} onChange={(e) => setF({ ...f, code: clientCode(e.target.value) })} />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor={`${uid}-industry`}>{t("form.industry")}</Label>
            <Input id={`${uid}-industry`} value={f.industry} maxLength={200} placeholder={t("form.industryPlaceholder")} onChange={(e) => setF({ ...f, industry: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor={`${uid}-legal`}>{t("form.legalName")}</Label>
            <Input id={`${uid}-legal`} value={f.legalName} placeholder={t("form.legalNamePlaceholder")} onChange={(e) => setF({ ...f, legalName: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-email`}>{t("form.email")}</Label>
            <Input id={`${uid}-email`} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-currency`}>{t("form.currency")}</Label>
            <Input id={`${uid}-currency`} maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor={`${uid}-status`}>{tc("status")}</Label>
            <select id={`${uid}-status`} className={selectClass} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as ClientStatus })}>
              {CLIENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </div>
        </form>
        <DialogFooter>
          <Button type="submit" form={`${uid}-form`} disabled={!f.name || m.isPending}>
            {tc("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
