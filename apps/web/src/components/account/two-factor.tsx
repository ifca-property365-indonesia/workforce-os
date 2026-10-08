"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";

interface Status {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
  hasPassword: boolean;
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  return (
    <div className="space-y-3">
      <p className="text-sm">{t("twoFactor.recoveryIntro")}</p>
      <ul className="grid grid-cols-2 gap-1 rounded-md bg-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => toast.success(tc("copied")))}>
          {tc("copy")}
        </Button>
        <Button type="button" onClick={onDone}>
          {t("twoFactor.savedThem")}
        </Button>
      </div>
    </div>
  );
}

/** QR enrollment: start → scan → confirm with the first code → show recovery codes once. */
export function EnrollTwoFactor({ onEnrolled }: { onEnrolled: () => void }) {
  const t = useTranslations("account");
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; qrDataUrl: string }>("/api/me/2fa/setup"),
    onSuccess: setSetup,
    onError: (e) => toast.error((e as Error).message),
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/api/me/2fa/enable", { code }),
    onSuccess: (r) => setCodes(r.recoveryCodes),
    onError: (e) => toast.error((e as Error).message),
  });

  if (codes) return <RecoveryCodes codes={codes} onDone={onEnrolled} />;
  if (!setup) {
    return (
      <Button type="button" onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? t("twoFactor.preparing") : t("twoFactor.setUp")}
      </Button>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        enable.mutate();
      }}
    >
      <p className="text-sm">{t("twoFactor.scan")}</p>
      <img src={setup.qrDataUrl} alt={t("twoFactor.qrAlt")} width={220} height={220} className="rounded-md border bg-white p-1" />
      <p className="text-xs text-muted-foreground">
        {t("twoFactor.manualKey")} <code className="select-all break-all font-mono">{setup.secret}</code>
      </p>
      <div className="max-w-40 space-y-1.5">
        <Label htmlFor="totp-code">{t("twoFactor.code")}</Label>
        <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </div>
      <Button disabled={code.length !== 6 || enable.isPending}>{enable.isPending ? t("twoFactor.checking") : t("twoFactor.turnOn")}</Button>
    </form>
  );
}

function ReauthForm({ hasPassword, submitLabel, onSubmit, pending }: { hasPassword: boolean; submitLabel: string; onSubmit: (v: { password?: string; code: string }) => void; pending: boolean }) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      className="max-w-sm space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ password: hasPassword ? password : undefined, code });
      }}
    >
      {hasPassword && (
        <div className="space-y-1.5">
          <Label htmlFor="reauth-password">{tc("password")}</Label>
          <Input id="reauth-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      )}
      <div className="max-w-40 space-y-1.5">
        <Label htmlFor="reauth-code">{t("twoFactor.authenticatorCode")}</Label>
        <Input id="reauth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </div>
      <Button variant="outline" disabled={code.length !== 6 || pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function TwoFactorCard() {
  const t = useTranslations("account");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["2fa"], queryFn: () => api.get<Status>("/api/me/2fa") });
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["2fa"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const disable = useMutation({
    mutationFn: (v: { password?: string; code: string }) => api.post("/api/me/2fa/disable", v),
    onSuccess: () => {
      setMode("idle");
      refresh();
      toast.success(t("twoFactor.turnedOff"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const regenerate = useMutation({
    mutationFn: (v: { password?: string; code: string }) => api.post<{ recoveryCodes: string[] }>("/api/me/2fa/recovery-codes", v),
    onSuccess: (r) => {
      setMode("idle");
      setNewCodes(r.recoveryCodes);
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("twoFactor.title")}</CardTitle>
        <CardDescription>
          {data.enabled ? t("twoFactor.statusOn", { count: data.recoveryCodesLeft }) : t("twoFactor.statusOff")}
          {data.required && ` ${t("twoFactor.requiredForRole")}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {newCodes ? (
          <RecoveryCodes codes={newCodes} onDone={() => setNewCodes(null)} />
        ) : !data.enabled ? (
          <EnrollTwoFactor onEnrolled={refresh} />
        ) : mode === "disable" ? (
          <ReauthForm hasPassword={data.hasPassword} submitLabel={t("twoFactor.turnOff")} pending={disable.isPending} onSubmit={(v) => disable.mutate(v)} />
        ) : mode === "regenerate" ? (
          <ReauthForm hasPassword={data.hasPassword} submitLabel={t("twoFactor.createNewCodes")} pending={regenerate.isPending} onSubmit={(v) => regenerate.mutate(v)} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setMode("regenerate")}>
              {t("twoFactor.newCodes")}
            </Button>
            {!data.required && (
              <Button variant="outline" onClick={() => setMode("disable")}>
                {t("twoFactor.turnOff")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
