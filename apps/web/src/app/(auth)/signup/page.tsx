"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";

export default function SignupPage() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [sample, setSample] = useState(true);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    try {
      await api.post("/api/auth/signup", {
        name: f.get("name"),
        email: f.get("email"),
        password: f.get("password"),
        workspaceName: f.get("workspaceName"),
        sampleData: sample,
      });
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
        <CardTitle className="text-2xl">{t("signup.title")}</CardTitle>
        <CardDescription>{t("signup.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="name">{t("signup.yourName")}</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">{tc("email")}</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">{tc("password")}</Label>
            <Input id="password" name="password" type="password" minLength={8} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workspaceName">{t("signup.workspaceName")}</Label>
            <Input id="workspaceName" name="workspaceName" placeholder={t("signup.workspacePlaceholder")} required />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={sample} onCheckedChange={(v) => setSample(!!v)} className="mt-0.5" />
            <span>{t("signup.sampleData")}</span>
          </label>
          <Button className="w-full" disabled={loading}>
            {loading ? t("signup.creating") : t("signup.submit")}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t.rich("signup.haveAccount", {
            link: (c) => (
              <Link href="/login" className="font-medium text-primary hover:underline">
                {c}
              </Link>
            ),
          })}
        </p>
      </CardContent>
    </Card>
  );
}
