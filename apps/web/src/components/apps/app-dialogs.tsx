"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, GitBranch, GitCommitHorizontal, Rocket } from "lucide-react";
import type { AppAccessMode, AppDTO, ReleaseDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { ReleaseOrigin } from "@/lib/app-previews";
import { useClients } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { AccessModePicker } from "./new-app-dialog";
import { deploySuggestions } from "./deploy-suggestions";
import { CommitChip, invalidateApp, selectClass, shortSha } from "./shared";

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Deploy the latest commit of a branch or one exact commit to the preview. It starts on the branch the preview ran
 * last (an agent's branch until it is merged, not the app's default) and offers the recent branches and commits as
 * picks, saying who made each and when; picking another branch than the one running says what it replaces.
 */
export function DeployDialog({ app, releases, origins = {}, onClose }: { app: AppDTO; releases: ReleaseDTO[]; origins?: Record<string, ReleaseOrigin>; onClose: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const suggestions = useMemo(() => deploySuggestions(releases, app.branch), [releases, app.branch]);
  const [mode, setMode] = useState<"branch" | "commit">("branch");
  const [branch, setBranch] = useState(suggestions.initialBranch);
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
  const current = app.preview.currentRelease;
  const chosenBranch = branch.trim() || app.branch;
  const chosenCommit = commit.trim().toLowerCase();
  const replaces = !!current && (mode === "branch" ? current.branch !== chosenBranch : commitOk && current.commit !== chosenCommit);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("deploy.title", { name: app.name })}</DialogTitle>
          <DialogDescription>{t("deploy.description", { server: app.preview.serverName })}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="min-w-0 space-y-3"
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
            <div className="space-y-2">
              {suggestions.branches.length > 1 && (
                <PickList label={t("deploy.recentBranches")}>
                  {suggestions.branches.map((b) => (
                    <Pick key={b.branch} name={`${uid}-branch-pick`} checked={chosenBranch === b.branch} onSelect={() => setBranch(b.branch)}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate font-mono text-xs font-semibold" title={b.branch}>
                          {b.branch}
                        </span>
                        {b.isDefault && <PickBadge>{t("deploy.defaultBranch")}</PickBadge>}
                        {current?.branch === b.branch && <PickBadge lit>{t("deploy.runningNow")}</PickBadge>}
                      </span>
                      {b.latest ? <ReleaseLine release={b.latest} origin={b.latest.taskId ? origins[b.latest.taskId] : undefined} /> : <span className="text-xs text-muted-foreground">{t("deploy.neverDeployed")}</span>}
                    </Pick>
                  ))}
                </PickList>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-branch`}>{t("form.branch")}</Label>
                <Input id={`${uid}-branch`} value={branch} maxLength={200} autoCapitalize="none" spellCheck={false} className="font-mono" onChange={(e) => setBranch(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {suggestions.commits.length > 0 && (
                <PickList label={t("deploy.recentCommits")}>
                  {suggestions.commits.map((r) => (
                    <Pick key={r.commit} name={`${uid}-commit-pick`} checked={chosenCommit === r.commit} onSelect={() => setCommit(r.commit)}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <CommitChip sha={r.commit} />
                        <span className="truncate text-xs font-medium">{r.commitSubject ?? r.branch}</span>
                        {current?.commit === r.commit && <PickBadge lit>{t("deploy.runningNow")}</PickBadge>}
                      </span>
                      <ReleaseLine release={r} origin={r.taskId ? origins[r.taskId] : undefined} showBranch />
                    </Pick>
                  ))}
                </PickList>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-commit`}>{t("deploy.commit")}</Label>
                <Input
                  id={`${uid}-commit`}
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
            </div>
          )}
          {replaces && current && (
            <div role="note" className="flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <p className="min-w-0 break-words">
                {t("deploy.replaces", { branch: current.branch, commit: shortSha(current.commit), subject: current.commitSubject ?? "—" })}
                {mode === "branch" && chosenBranch === app.branch && current.taskId && <> {t("deploy.notMerged", { branch: app.branch })}</>}
              </p>
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

function PickList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="max-h-56 space-y-1.5 overflow-y-auto pr-0.5">{children}</div>
    </fieldset>
  );
}

function Pick({ name, checked, onSelect, children }: { name: string; checked: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-2 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        checked ? "border-foreground bg-secondary/60" : "hover:bg-secondary/40",
      )}
    >
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onSelect} />
      {children}
    </label>
  );
}

function PickBadge({ lit, children }: { lit?: boolean; children: ReactNode }) {
  return <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", lit ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>{children}</span>;
}

/** "subject · abc1234 · Arif via <task> · 5 min ago" under a pick (the branch too in the commit list). */
function ReleaseLine({ release: r, origin, showBranch }: { release: ReleaseDTO; origin: ReleaseOrigin | undefined; showBranch?: boolean }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const by = origin ? t("deploy.byTask", { employee: origin.employeeName ?? t("releases.unknownEmployee"), title: origin.taskTitle }) : r.createdByName;
  const parts = [showBranch ? r.branch : r.commitSubject, showBranch ? null : shortSha(r.commit), by, f.ago(r.createdAt)].filter((x): x is string => !!x);
  return (
    <span className="truncate text-xs text-muted-foreground" title={parts.join(" · ")}>
      {parts.join(" · ")}
    </span>
  );
}

/** Name, default branch, client/project and access. Slug, server and repository are fixed. */
export function EditAppDialog({ app, onClose }: { app: AppDTO; onClose: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const { data: clients } = useClients();
  const [f, setF] = useState({ name: app.name, branch: app.branch, clientId: app.clientId ?? "", projectId: app.projectId ?? "", accessMode: app.preview.accessMode as AppAccessMode });
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
