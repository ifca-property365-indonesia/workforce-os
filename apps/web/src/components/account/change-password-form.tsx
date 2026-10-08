"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";

/** Shared by Settings → Account and the forced first-login screen. */
export function ChangePasswordForm({ onDone, submitLabel, hasPassword = true }: { onDone?: () => void; submitLabel?: string; hasPassword?: boolean }) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [f, setF] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const mismatch = !!f.confirm && f.confirm !== f.newPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.newPassword !== f.confirm) return;
    setSaving(true);
    try {
      await api.post("/api/me/password", { currentPassword: hasPassword ? f.currentPassword : undefined, newPassword: f.newPassword });
      toast.success(t("password.changed"));
      setF({ currentPassword: "", newPassword: "", confirm: "" });
      onDone?.();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      {hasPassword && (
        <div className="space-y-1.5">
          <Label htmlFor="cp-current">{t("password.current")}</Label>
          <Input id="cp-current" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="cp-new">{t("password.new")}</Label>
        <Input id="cp-new" type="password" autoComplete="new-password" required minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} />
        <p className="text-xs text-muted-foreground">{t("password.minLength", { min: 10 })}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cp-confirm">{t("password.confirm")}</Label>
        <Input id="cp-confirm" type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} aria-invalid={mismatch} />
        {mismatch && <p className="text-xs text-destructive">{t("password.mismatch")}</p>}
      </div>
      <Button disabled={saving || mismatch || f.newPassword.length < 10}>{saving ? tc("saving") : (submitLabel ?? t("password.change"))}</Button>
    </form>
  );
}
