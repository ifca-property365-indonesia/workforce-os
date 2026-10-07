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
import { api } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [loading, setLoading] = useState(false);
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
      await api.post("/api/auth/login", { email: f.get("email"), password: f.get("password") });
      router.replace("/dashboard");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
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
