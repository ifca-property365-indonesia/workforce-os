"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { CompanyProfile } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useCompanyProfile, useMe } from "@/lib/hooks";

type TextKey = Exclude<keyof CompanyProfile, "defaultTaxPercent" | "address" | "invoiceFooter">;

/** Settings → Company profile: what invoices print about us (Admins edit; everyone else reads). */
export function CompanyProfileSettings({ admin }: { admin: boolean }) {
  const { data: me } = useMe();
  const { data } = useCompanyProfile(!!me && me.role !== "VIEWER");
  return data ? <CompanyProfileForm initial={data} admin={admin} /> : null;
}

function CompanyProfileForm({ initial, admin }: { initial: CompanyProfile; admin: boolean }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const [f, setF] = useState<CompanyProfile>(initial);
  const save = useMutation({
    mutationFn: (body: CompanyProfile) => api.put<{ company: CompanyProfile }>("/api/settings/company", body),
    onSuccess: (r) => {
      toast.success(tc("saved"));
      setF(r.company);
      qc.setQueryData(["company"], r.company);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const text = (k: TextKey, props: { type?: string; placeholder?: string; className?: string } = {}) => (
    <div className={props.className ?? "space-y-1.5"}>
      <Label htmlFor={`${uid}-${k}`}>{t(`company.${k}`)}</Label>
      <Input id={`${uid}-${k}`} type={props.type} placeholder={props.placeholder} value={f[k]} disabled={!admin} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </div>
  );
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">{t("company.title")}</CardTitle>
        <CardDescription>{admin ? t("company.description") : t("company.readOnly")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(f);
          }}
        >
          {text("legalName", { placeholder: t("company.legalNamePlaceholder") })}
          {text("taxId")}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-address`}>{t("company.address")}</Label>
            <Textarea id={`${uid}-address`} rows={3} value={f.address} disabled={!admin} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </div>
          {text("phone", { type: "tel" })}
          {text("email", { type: "email" })}
          <div className="border-t pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:col-span-2">{t("company.bankSection")}</div>
          {text("bankName")}
          {text("bankAccount")}
          {text("bankHolder", { className: "space-y-1.5 sm:col-span-2" })}
          <div className="border-t pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:col-span-2">{t("company.invoiceSection")}</div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-invoicePrefix`}>{t("company.invoicePrefix")}</Label>
            <Input id={`${uid}-invoicePrefix`} value={f.invoicePrefix} disabled={!admin} maxLength={20} onChange={(e) => setF({ ...f, invoicePrefix: e.target.value })} />
            <p className="text-xs text-muted-foreground">{t("company.invoicePrefixHelp", { example: `${f.invoicePrefix ? `${f.invoicePrefix}-` : ""}${new Date().getFullYear()}-0001` })}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-tax`}>{t("company.defaultTaxPercent")}</Label>
            <Input id={`${uid}-tax`} type="number" min={0} max={100} step="0.01" value={f.defaultTaxPercent} disabled={!admin} onChange={(e) => setF({ ...f, defaultTaxPercent: Number(e.target.value) })} />
            <p className="text-xs text-muted-foreground">{t("company.defaultTaxHelp")}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-footer`}>{t("company.invoiceFooter")}</Label>
            <Textarea id={`${uid}-footer`} rows={3} value={f.invoiceFooter} placeholder={t("company.invoiceFooterPlaceholder")} disabled={!admin} onChange={(e) => setF({ ...f, invoiceFooter: e.target.value })} />
          </div>
          {admin && (
            <div className="sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? tc("saving") : tc("save")}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
