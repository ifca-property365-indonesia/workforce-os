"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

/** Shared by Settings → Account and the forced first-login screen. */
export function ChangePasswordForm({ onDone, submitLabel = "Change password", hasPassword = true }: { onDone?: () => void; submitLabel?: string; hasPassword?: boolean }) {
  const [f, setF] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const mismatch = !!f.confirm && f.confirm !== f.newPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.newPassword !== f.confirm) return;
    setSaving(true);
    try {
      await api.post("/api/me/password", { currentPassword: hasPassword ? f.currentPassword : undefined, newPassword: f.newPassword });
      toast.success("Password changed. Other sessions were signed out.");
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
          <Label htmlFor="cp-current">Current password</Label>
          <Input id="cp-current" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="cp-new">New password</Label>
        <Input id="cp-new" type="password" autoComplete="new-password" required minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} />
        <p className="text-xs text-muted-foreground">At least 10 characters.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cp-confirm">Confirm new password</Label>
        <Input id="cp-confirm" type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} aria-invalid={mismatch} />
        {mismatch && <p className="text-xs text-destructive">Passwords do not match.</p>}
      </div>
      <Button disabled={saving || mismatch || f.newPassword.length < 10}>{saving ? "Saving…" : submitLabel}</Button>
    </form>
  );
}
