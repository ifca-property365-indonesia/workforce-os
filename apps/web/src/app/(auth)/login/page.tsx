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
import { api, ApiError } from "@/lib/api";

function lockMessage(err: unknown): string {
  const data = err instanceof ApiError ? (err.data as { code?: string; lockedUntil?: string } | undefined) : undefined;
  if (data?.code === "account_locked" && data.lockedUntil) {
    const at = new Date(data.lockedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `Too many failed attempts. Try again at ${at}.`;
  }
  return (err as Error).message;
}

function SecondFactor({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await api.post<{ mustChangePassword?: boolean; recoveryCodesLeft?: number }>("/api/auth/login/2fa", useRecovery ? { recoveryCode: value } : { code: value });
      if (r.recoveryCodesLeft !== undefined) toast.warning(`Recovery code used. ${r.recoveryCodesLeft} left.`);
      router.replace(r.mustChangePassword ? "/change-password" : "/dashboard");
    } catch (err) {
      toast.error(lockMessage(err));
      if (err instanceof ApiError && (err.data as { code?: string })?.code !== "invalid_code") onBack();
    } finally {
      setLoading(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="second-factor">{useRecovery ? "Recovery code" : "Authenticator code"}</Label>
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
        {loading ? "Checking…" : "Verify"}
      </Button>
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground hover:underline"
        onClick={() => {
          setUseRecovery(!useRecovery);
          setValue("");
        }}
      >
        {useRecovery ? "Use the authenticator code instead" : "Use a recovery code instead"}
      </button>
    </form>
  );
}

function LoginForm() {
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
      toast.error(lockMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (step === "2fa") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Two-factor authentication</CardTitle>
          <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
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
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>Welcome back to Workforce OS.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">Sign-in failed: {error.replace(/_/g, " ")}</p>}
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        {cfg?.google && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Separator className="flex-1" /> or <Separator className="flex-1" />
            </div>
            <Button variant="outline" className="w-full" asChild>
              <a href="/api/auth/google">Continue with Google</a>
            </Button>
          </>
        )}
        {cfg?.signup ? (
          <p className="text-center text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/signup" className="font-medium text-primary hover:underline">
              Create a workspace
            </Link>
          </p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">Accounts are created by a workspace admin.</p>
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
