"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { PageHeader } from "@/components/layout/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";

function Profile() {
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
      toast.success("Profile saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!me) return null;
  const dirty = name.trim() !== me.user.name && !!name.trim();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription>Your name is shown to teammates, in approvals and in the audit log.</CardDescription>
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
            <Label htmlFor="profile-name">Name</Label>
            <Input id="profile-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-email">Email</Label>
            <Input id="profile-email" value={me.user.email} disabled />
            <p className="text-xs text-muted-foreground">Your sign-in email cannot be changed here.</p>
          </div>
          <div className="text-xs text-muted-foreground">
            Role in {me.workspace.name}: <span className="font-medium text-foreground">{me.role}</span>
          </div>
          <Button disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Password() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password</CardTitle>
        <CardDescription>Changing your password signs out every other session.</CardDescription>
      </CardHeader>
      <CardContent>
        {!me.user.hasPassword && <p className="mb-3 text-sm text-muted-foreground">You sign in with Google. Set a password to also sign in with email.</p>}
        <ChangePasswordForm hasPassword={me.user.hasPassword} submitLabel={me.user.hasPassword ? "Change password" : "Set password"} />
      </CardContent>
    </Card>
  );
}

export default function AccountPage() {
  return (
    <div>
      <PageHeader title="Account" description="Your profile and sign-in settings." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Profile />
        <Password />
      </div>
    </div>
  );
}
