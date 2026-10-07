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
import { api } from "@/lib/api";

export default function SignupPage() {
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
        <CardTitle className="text-2xl">Create your workspace</CardTitle>
        <CardDescription>You will be the Owner.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" minLength={8} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workspaceName">Workspace name</Label>
            <Input id="workspaceName" name="workspaceName" placeholder="Acme Studio" required />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={sample} onCheckedChange={(v) => setSample(!!v)} className="mt-0.5" />
            <span>Add sample data (3 employees, 2 clients, 1 weekly routine)</span>
          </label>
          <Button className="w-full" disabled={loading}>
            {loading ? "Creating…" : "Create workspace"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
