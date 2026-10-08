"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { TwoFactorCard } from "@/components/account/two-factor";
import { TelegramCard } from "@/components/account/telegram";
import { PageHeader } from "@/components/layout/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { useTranslations } from "next-intl";
import { LOCALES, LOCALE_NAMES } from "@wfos/shared";

function Profile() {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [name, setName] = useState("");
  useEffect(() => {
    if (me) setName(me.user.name);
  }, [me]);
  const save = useMutation({
    mutationFn: () => api.patch("/api/me", { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me"] });
      void qc.invalidateQueries({ queryKey: ["members"] });
      toast.success(t("profile.saved"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!me) return null;
  const dirty = name.trim() !== me.user.name && !!name.trim();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("profile.title")}</CardTitle>
        <CardDescription>{t("profile.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-sm space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">{tc("name")}</Label>
            <Input id="profile-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-email">{tc("email")}</Label>
            <Input id="profile-email" value={me.user.email} disabled />
            <p className="text-xs text-muted-foreground">{t("profile.emailFixed")}</p>
          </div>
          <div className="text-xs text-muted-foreground">
            {t.rich("profile.roleIn", {
              workspace: me.workspace.name,
              role: ts(`role.${me.role}`),
              b: (c) => <span className="font-medium text-foreground">{c}</span>,
            })}
          </div>
          <Button disabled={!dirty || save.isPending}>{save.isPending ? tc("saving") : tc("save")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Password() {
  const t = useTranslations("account");
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("password.title")}</CardTitle>
        <CardDescription>{t("password.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!me.user.hasPassword && <p className="mb-3 text-sm text-muted-foreground">{t("password.googleOnly")}</p>}
        <ChangePasswordForm hasPassword={me.user.hasPassword} submitLabel={me.user.hasPassword ? t("password.change") : t("password.set")} />
      </CardContent>
    </Card>
  );
}

function Language() {
  const t = useTranslations("account");
  const { data: me } = useMe();
  const save = useMutation({
    mutationFn: (locale: string | null) => api.patch("/api/me", { locale }),
    onSuccess: () => window.location.reload(),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!me) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("language.title")}</CardTitle>
        <CardDescription>{t("language.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Label htmlFor="ui-language" className="sr-only">
          {t("language.title")}
        </Label>
        <select
          id="ui-language"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={me.user.locale ?? ""}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.value || null)}
        >
          <option value="">{t("language.followWorkspace")}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  );
}

export default function AccountPage() {
  const t = useTranslations("account");
  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Profile />
        <Password />
        <TwoFactorCard />
        <Language />
        <TelegramCard />
      </div>
    </div>
  );
}
