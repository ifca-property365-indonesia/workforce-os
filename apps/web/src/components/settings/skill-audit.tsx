"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useEmployees } from "@/lib/hooks";
import { SKILLS_QK, type SkillRow } from "./skills";

interface AuditState {
  settings: { monthly: boolean; hrEmployeeId: string | null };
  hrEmployee: { id: string; name: string } | null;
  last: { taskId: string; title: string; status: string; trigger: string; createdAt: string } | null;
  pendingProposals: number;
}

const AUDIT_QK = ["skill-audit"] as const;
const RUNNING = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"];

/** C4: the HR employee reviews the team and proposes catalog skills; each proposal is an approval. Admins only. */
export function SkillAuditCard() {
  const t = useTranslations("skills.audit");
  const ts = useTranslations("status.task");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: AUDIT_QK, queryFn: () => api.get<AuditState>("/api/hr/skill-audit") });
  const { data: employees } = useEmployees();
  const active = (employees ?? []).filter((e) => e.status !== "ARCHIVED");

  const save = useMutation({
    mutationFn: (v: Partial<AuditState["settings"]>) => api.put("/api/hr/skill-audit", v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: AUDIT_QK }),
    onError: (e) => toast.error((e as Error).message),
  });
  const start = useMutation({
    mutationFn: () => api.post<{ taskId: string }>("/api/hr/skill-audit", {}),
    onSuccess: () => {
      toast.success(t("started", { name: data?.hrEmployee?.name ?? "HR" }));
      void qc.invalidateQueries({ queryKey: AUDIT_QK });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const running = !!data?.last && RUNNING.includes(data.last.status);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> {t("title")}
        </CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="skill-audit-hr">{t("hrEmployee")}</Label>
            <select
              id="skill-audit-hr"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={data?.settings.hrEmployeeId ?? ""}
              disabled={!data || save.isPending}
              onChange={(e) => save.mutate({ hrEmployeeId: e.target.value || null })}
            >
              <option value="">{data?.hrEmployee && !data.settings.hrEmployeeId ? t("hrDefaultNamed", { name: data.hrEmployee.name }) : t("hrDefault")}</option>
              {active.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.role}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 self-end text-sm">
            <Switch checked={!!data?.settings.monthly} disabled={!data || save.isPending} onCheckedChange={(v) => save.mutate({ monthly: v })} aria-label={t("monthly")} />
            {t("monthly")}
          </label>
        </div>
        {data && !data.hrEmployee && <p className="text-xs text-warning">{t("noHr")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="gap-1.5" disabled={!data?.hrEmployee || running || start.isPending} onClick={() => start.mutate()}>
            <Sparkles className="size-3.5" /> {t("start")}
          </Button>
          {data?.last && (
            <Link href={`/tasks/${data.last.taskId}`} className="text-xs text-primary hover:underline">
              {t("last", { status: ts.has(data.last.status) ? ts(data.last.status) : data.last.status })}
            </Link>
          )}
          {!!data?.pendingProposals && (
            <Link href="/approvals" className="text-xs text-primary hover:underline">
              {t("pending", { count: data.pendingProposals })}
            </Link>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </CardContent>
    </Card>
  );
}

interface UpdatePreview {
  current: { commit: string; description: string; body: string; files: string[]; license: string | null };
  next: {
    commit: string;
    contentHash: string;
    filesHash: string;
    path: string;
    url: string;
    description: string;
    body: string;
    files: { path: string; size: number; fetched: boolean; content: string | null }[];
    license: string | null;
    sameFolder: boolean;
  };
}

/** A newer commit of a catalog skill: both versions side by side; applying takes exactly the version shown. */
export function SkillUpdateDialog({ skill, onClose }: { skill: SkillRow; onClose: () => void }) {
  const t = useTranslations("skills.update");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ["skill-update", skill.id], queryFn: () => api.get<UpdatePreview>(`/api/skills/${skill.id}/update`), retry: false });
  const apply = useMutation({
    mutationFn: () => api.post(`/api/skills/${skill.id}/update`, { commit: data!.next.commit, contentHash: data!.next.contentHash, filesHash: data!.next.filesHash }),
    onSuccess: () => {
      toast.success(t("applied", { slug: skill.slug }));
      void qc.invalidateQueries({ queryKey: SKILLS_QK });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("title", { slug: skill.slug })}</DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">{tc("loading")}</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              <code>{data.current.commit.slice(0, 8)}</code> → <code>{data.next.commit.slice(0, 8)}</code> · {t("license", { license: data.next.license ?? "—" })}{" "}
              <a href={data.next.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                GitHub <ExternalLink className="size-3" />
              </a>
            </p>
            {!data.next.sameFolder && <p className="text-xs text-destructive">{t("moved")}</p>}
            <div className="grid gap-3 md:grid-cols-2">
              {(["current", "next"] as const).map((k) => (
                <div key={k} className="min-w-0 space-y-1">
                  <div className="text-xs font-medium">{t(k)}</div>
                  <p className="break-words text-xs text-muted-foreground">{data[k].description}</p>
                  <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-xs">{data[k].body}</pre>
                  <p className="text-xs text-muted-foreground">{t("files", { list: (k === "current" ? data.current.files : data.next.files.map((f) => f.path)).join(", ") || "—" })}</p>
                </div>
              ))}
            </div>
            {data.next.files.some((f) => f.content !== null) && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">{t("newFiles")}</summary>
                {data.next.files
                  .filter((f) => f.content !== null)
                  .map((f) => (
                    <div key={f.path} className="mt-2 space-y-1">
                      <div className="font-mono text-xs">{f.path}</div>
                      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-xs">{f.content}</pre>
                    </div>
                  ))}
              </details>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button disabled={!data || !data.next.license || !data.next.sameFolder || apply.isPending} onClick={() => apply.mutate()}>
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
