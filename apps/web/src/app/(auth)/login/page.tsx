"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";


function SecondFactor({ onBack }: { onBack: () => void }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await api.post<{ mustChangePassword?: boolean; recoveryCodesLeft?: number }>("/api/auth/login/2fa", useRecovery ? { recoveryCode: value } : { code: value });
      if (r.recoveryCodesLeft !== undefined) toast.warning(t("login.recoveryUsed", { count: r.recoveryCodesLeft }));
      router.replace(r.mustChangePassword ? "/change-password" : "/dashboard");
    } catch (err) {
      // the server message is already translated and says when a locked account can try again
      toast.error((err as Error).message);
      if (err instanceof ApiError && (err.data as { code?: string })?.code !== "invalid_code") onBack();
    } finally {
      setLoading(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="second-factor">{useRecovery ? t("login.recoveryCode") : t("login.authenticatorCode")}</Label>
        <Input
          id="second-factor"
          autoFocus
          required
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          maxLength={useRecovery ? 20 : 6}
          value={value}
          onChange={(e) => setValue(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
        />
      </div>
      <Button className="w-full" disabled={loading || (!useRecovery && value.length !== 6)}>
        {loading ? t("login.checking") : t("login.verify")}
      </Button>
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground hover:underline"
        onClick={() => {
          setUseRecovery(!useRecovery);
          setValue("");
        }}
      >
        {useRecovery ? t("login.useAuthenticator") : t("login.useRecovery")}
      </button>
    </form>
  );
}

function LoginForm() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const router = useRouter();
  const sp = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"password" | "2fa">(sp.get("step") === "2fa" ? "2fa" : "password");
  const error = sp.get("error");
  const [cfg, setCfg] = useState<{ signup: boolean; google: boolean } | null>(null);
  useEffect(() => {
    api.get<{ signup: boolean; google: boolean }>("/api/auth/config").then(setCfg).catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    try {
      const r = await api.post<{ mustChangePassword?: boolean; twoFactorRequired?: boolean }>("/api/auth/login", { email: f.get("email"), password: f.get("password") });
      if (r.twoFactorRequired) setStep("2fa");
      else router.replace(r.mustChangePassword ? "/change-password" : "/dashboard");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (step === "2fa") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t("login.twoFactorTitle")}</CardTitle>
          <CardDescription>{t("login.twoFactorDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SecondFactor onBack={() => setStep("password")} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">{t("login.title")}</CardTitle>
        <CardDescription>{t("login.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {t("login.failed", { reason: t.has(`login.oauthErrors.${error}`) ? t(`login.oauthErrors.${error}`) : error.replace(/_/g, " ") })}
          </p>
        )}
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="email">{tc("email")}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">{tc("password")}</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button className="w-full" disabled={loading}>
            {loading ? t("login.signingIn") : t("login.submit")}
          </Button>
        </form>
        {cfg?.google && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Separator className="flex-1" /> {tc("or")} <Separator className="flex-1" />
            </div>
            <Button variant="outline" className="w-full" asChild>
              <a href="/api/auth/google">{t("login.google")}</a>
            </Button>
          </>
        )}
        {cfg?.signup ? (
          <p className="text-center text-sm text-muted-foreground">
            {t.rich("login.noAccount", {
              link: (c) => (
                <Link href="/signup" className="font-medium text-primary hover:underline">
                  {c}
                </Link>
              ),
            })}
          </p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">{t("login.adminCreatesAccounts")}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
