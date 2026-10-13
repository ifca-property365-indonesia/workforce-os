"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { GitBranch, GitCommitHorizontal, Rocket } from "lucide-react";
import type { AppAccessMode, AppDTO, ReleaseDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useClients } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AccessModePicker } from "./new-app-dialog";
import { invalidateApp, selectClass } from "./shared";

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Deploy the latest commit of a branch (the app's by default) or one exact commit. */
export function DeployDialog({ app, onClose }: { app: AppDTO; onClose: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const [mode, setMode] = useState<"branch" | "commit">("branch");
  const [branch, setBranch] = useState(app.branch);
  const [commit, setCommit] = useState("");
  const commitOk = COMMIT_RE.test(commit.trim().toLowerCase());
  const m = useMutation({
    mutationFn: () => api.post<{ release: ReleaseDTO }>(`/api/apps/${app.id}/deploy`, mode === "commit" ? { commit: commit.trim().toLowerCase() } : { branch: branch.trim() || app.branch }),
    onSuccess: () => {
      invalidateApp(qc, app.id);
      toast.success(t("actions.deployQueued"));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const valid = mode === "commit" ? commitOk : true;
  const options = [
    { v: "branch" as const, icon: GitBranch, label: t("deploy.branch") },
    { v: "commit" as const, icon: GitCommitHorizontal, label: t("deploy.commit") },
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("deploy.title", { name: app.name })}</DialogTitle>
          <DialogDescription>{t("deploy.description", { server: app.serverName })}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) m.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {options.map((o) => (
              <label
                key={o.v}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  mode === o.v ? "border-foreground bg-secondary/60" : "text-muted-foreground hover:bg-secondary/40",
                )}
              >
                <input type="radio" name={`${uid}-mode`} className="sr-only" checked={mode === o.v} onChange={() => setMode(o.v)} />
                <o.icon className="size-4 shrink-0" aria-hidden />
                {o.label}
              </label>
            ))}
          </div>
          {mode === "branch" ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-branch`}>{t("form.branch")}</Label>
              <Input id={`${uid}-branch`} autoFocus value={branch} maxLength={200} autoCapitalize="none" spellCheck={false} className="font-mono" onChange={(e) => setBranch(e.target.value)} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-commit`}>{t("deploy.commit")}</Label>
              <Input
                id={`${uid}-commit`}
                autoFocus
                value={commit}
                maxLength={40}
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                placeholder={t("deploy.commitPlaceholder")}
                aria-invalid={!!commit && !commitOk}
                onChange={(e) => setCommit(e.target.value)}
              />
              {!!commit && !commitOk && <p className="text-xs text-destructive">{t("deploy.commitInvalid")}</p>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("deploy.audited")}</p>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} className="gap-1.5" disabled={!valid || m.isPending}>
            <Rocket className="size-4" aria-hidden /> {t("deploy.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Name, default branch, client/project and access. Slug, server and repository are fixed. */
export function EditAppDialog({ app, onClose }: { app: AppDTO; onClose: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const { data: clients } = useClients();
  const [f, setF] = useState({ name: app.name, branch: app.branch, clientId: app.clientId ?? "", projectId: app.projectId ?? "", accessMode: app.accessMode as AppAccessMode });
  const projects = clients?.find((c) => c.id === f.clientId)?.projects ?? [];
  const m = useMutation({
    mutationFn: () =>
      api.patch(`/api/apps/${app.id}`, { name: f.name.trim(), branch: f.branch.trim(), clientId: f.clientId || null, projectId: f.projectId || null, accessMode: f.accessMode }),
    onSuccess: () => {
      invalidateApp(qc, app.id);
      toast.success(t("detail.saved"));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("detail.editTitle", { name: app.name })}</DialogTitle>
          <DialogDescription>{t("detail.fixed")}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim() && f.branch.trim()) m.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>{t("form.name")}</Label>
            <Input id={`${uid}-name`} value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-branch`}>{t("form.branch")}</Label>
            <Input id={`${uid}-branch`} value={f.branch} maxLength={200} autoCapitalize="none" spellCheck={false} className="font-mono" onChange={(e) => setF({ ...f, branch: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-client`}>{t("form.client")}</Label>
              <select id={`${uid}-client`} className={selectClass} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value, projectId: "" })}>
                <option value="">{t("form.none")}</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-project`}>{t("form.project")}</Label>
              <select id={`${uid}-project`} className={selectClass} value={f.projectId} disabled={!projects.length} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                <option value="">{t("form.none")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <AccessModePicker value={f.accessMode} onChange={(accessMode) => setF({ ...f, accessMode })} />
          <p className="text-xs text-muted-foreground">{t("detail.nextDeploy")}</p>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!f.name.trim() || !f.branch.trim() || m.isPending}>
            {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
