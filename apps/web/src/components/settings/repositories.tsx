"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

interface Repo {
  id: string;
  name: string;
  provider: "github" | "gitlab" | "git";
  url: string;
  defaultBranch: string;
  tokenSet: boolean;
  tokenLast4: string | null;
}

/** Git repositories Workspace-mode employees work on. The token stays with the platform. */
export function RepositoriesSettings({ owner }: { owner: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["repositories"], queryFn: () => api.get<{ repositories: Repo[] }>("/api/repositories").then((r) => r.repositories) });
  const [f, setF] = useState({ name: "", provider: "github" as Repo["provider"], url: "", defaultBranch: "main", token: "" });
  const add = useMutation({
    mutationFn: () => api.post("/api/repositories", { ...f, token: f.token || undefined }),
    onSuccess: () => {
      setF({ name: "", provider: "github", url: "", defaultBranch: "main", token: "" });
      toast.success(t("repositories.added"));
      void qc.invalidateQueries({ queryKey: ["repositories"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/repositories/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["repositories"] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("repositories.title")}</CardTitle>
        <CardDescription>{t("repositories.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm">
          {data?.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <span className="font-medium">{r.name}</span>
              <code className="text-xs text-muted-foreground">{r.url}</code>
              <span className="text-xs text-muted-foreground">{t("repositories.branchAndToken", { branch: r.defaultBranch, token: r.tokenSet ? `…${r.tokenLast4}` : t("repositories.noToken") })}</span>
              {owner && (
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(editing === r.id ? null : r.id)}>
                    {t("repositories.edit")}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(t("repositories.removeConfirm", { name: r.name })) && remove.mutate(r.id)}>
                    {tc("remove")}
                  </Button>
                </span>
              )}
              {owner && editing === r.id && <EditRepository repo={r} onDone={() => setEditing(null)} />}
            </li>
          ))}
          {!data?.length && <li className="text-muted-foreground">{t("repositories.empty")}</li>}
        </ul>
        {owner && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="repo-name">{tc("name")}</Label>
              <Input id="repo-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repo-provider">{t("repositories.provider")}</Label>
              <select id="repo-provider" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as Repo["provider"] })}>
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
                <option value="git">{t("repositories.otherGit")}</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="repo-url">{t("repositories.url")}</Label>
              {/* i18n-ignore: example URL */}
              <Input id="repo-url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://github.com/acme/app.git" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repo-branch">{t("repositories.defaultBranch")}</Label>
              <Input id="repo-branch" value={f.defaultBranch} onChange={(e) => setF({ ...f, defaultBranch: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repo-token">{t("repositories.token")}</Label>
              <Input id="repo-token" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t("repositories.tokenHelp")}</p>
            <div>
              <Button disabled={!f.name || !f.url || add.isPending}>{t("repositories.add")}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Change a repository's clone URL, default branch or token without removing it (its tasks and apps stay linked). */
function EditRepository({ repo, onDone }: { repo: Repo; onDone: () => void }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const [f, setF] = useState({ url: repo.url, defaultBranch: repo.defaultBranch, token: "", removeToken: false });
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/repositories/${repo.id}`, {
        ...(f.url !== repo.url ? { url: f.url } : {}),
        ...(f.defaultBranch !== repo.defaultBranch ? { defaultBranch: f.defaultBranch } : {}),
        ...(f.removeToken ? { token: null } : f.token ? { token: f.token } : {}),
      }),
    onSuccess: () => {
      toast.success(t("repositories.updated"));
      void qc.invalidateQueries({ queryKey: ["repositories"] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <form
      className="grid w-full gap-3 border-t pt-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`repo-url-${repo.id}`}>{t("repositories.url")}</Label>
        <Input id={`repo-url-${repo.id}`} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`repo-branch-${repo.id}`}>{t("repositories.defaultBranch")}</Label>
        <Input id={`repo-branch-${repo.id}`} value={f.defaultBranch} onChange={(e) => setF({ ...f, defaultBranch: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`repo-token-${repo.id}`}>{t("repositories.newToken")}</Label>
        <Input
          id={`repo-token-${repo.id}`}
          type="password"
          autoComplete="off"
          disabled={f.removeToken}
          value={f.token}
          placeholder={repo.tokenSet ? `…${repo.tokenLast4}` : ""}
          onChange={(e) => setF({ ...f, token: e.target.value })}
        />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">{t("repositories.newTokenHelp")}</p>
      {repo.tokenSet && (
        <label className="flex items-center gap-2 text-xs sm:col-span-2">
          <input type="checkbox" checked={f.removeToken} onChange={(e) => setF({ ...f, removeToken: e.target.checked, token: "" })} />
          {t("repositories.removeToken")}
        </label>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" disabled={!f.url || !f.defaultBranch || save.isPending}>
          {t("repositories.save")}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onDone}>
          {tc("cancel")}
        </Button>
      </div>
    </form>
  );
}
