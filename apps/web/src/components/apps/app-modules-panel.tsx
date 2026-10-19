"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Blocks, GitCompare, Hammer, Pause, Play, Plus, X } from "lucide-react";
import Link, { useSearchParams } from "@/lib/nav";
import type { AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { lineDiff } from "@/lib/doc-format";
import { useEmployees, useTeams } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { DocMarkdown } from "./doc-markdown";

export type ModuleStatus = "draft" | "ready" | "building" | "in_review" | "merged" | "live" | "paused" | "dropped";
interface TaskRef {
  taskId: string;
  title: string;
  role: "prd" | "build" | "change" | "register";
  status: string;
  createdAt: string;
}
export interface ModuleView {
  id: string;
  slug: string;
  name: string;
  summary: string;
  hold: "paused" | "dropped" | null;
  status: ModuleStatus;
  prd: { approved: { id: string; version: number } | null; draft: { id: string; version: number } | null };
  writingPrd: boolean;
  active: TaskRef | null;
  pending: { role: "build" | "change"; note: string; requestedAt: string } | null;
  tasks: TaskRef[];
  work: { taskId: string; title: string; branch: string; head: string; pushedAt: string; state: "unmerged" | "pending" | "merged" | "skipped" | "failed" }[];
  inPreview: boolean;
  inLive: boolean;
}
interface PrdVersion {
  id: string;
  version: number;
  title: string;
  status: "draft" | "approved" | "superseded" | "rejected";
  note: string;
  basedOnVersion: number | null;
  taskId: string | null;
  author: string | null;
  createdAt: string;
}
interface DocDetail {
  doc: PrdVersion & { content: string };
  approved: { id: string; version: number; content: string } | null;
}

export const modulesQueryKey = (appId: string) => ["app", appId, "modules"] as const;
export const useAppModules = (appId: string, enabled = true) =>
  useQuery({ queryKey: modulesQueryKey(appId), queryFn: () => api.get<{ modules: ModuleView[]; hasRepository: boolean }>(`/api/apps/${appId}/modules`), enabled });

const STATUS_TONE: Record<ModuleStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-[var(--sign-biru)]/15 text-[var(--sign-biru)]",
  building: "bg-warning/25",
  in_review: "bg-[var(--sign-biru)]/25",
  merged: "bg-success/10 text-success",
  live: "bg-success/20 text-success",
  paused: "bg-muted text-muted-foreground",
  dropped: "bg-destructive/10 text-destructive line-through",
};
const DOC_TONE: Record<PrdVersion["status"], string> = { draft: "bg-[var(--sign-biru)]/15", approved: "bg-success/15 text-success", superseded: "bg-muted text-muted-foreground", rejected: "bg-destructive/15 text-destructive" };
/** writers first: roles that write requirements (project, product, analyst) */
const WRITER_RE = /\b(project|product|pm|analyst|analis|bisnis|business)\b/i;
const onError = (e: unknown) => toast.error((e as Error).message);

/**
 * C8: the app's modules. Each module has its own PRD (drafted by an employee, approved by an Admin or the Owner) and is
 * built or changed by a code task on the app's repository, one per app at a time; its status comes from that work.
 */
export function AppModulesPanel({ app, admin, member }: { app: Pick<AppDTO, "id" | "name">; admin: boolean; member: boolean }) {
  const t = useTranslations("apps.modules");
  const params = useSearchParams();
  const focus = params.get("module");
  const { data } = useAppModules(app.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // a link from Needs a decision (?module=…&doc=…) opens that module
  useEffect(() => {
    if (!focus || !data?.modules.some((m) => m.id === focus)) return;
    setPicked(focus);
    document.getElementById("app-modules-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, data]);

  const modules = data?.modules ?? [];
  const shown = modules.find((m) => m.id === picked) ?? null;
  const building = modules.find((m) => m.active)?.active ?? null;

  return (
    <section className="space-y-3" aria-labelledby="app-modules-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="app-modules-title" className="font-display flex-1 text-[1.7rem] leading-none">
          {t("title")}
        </h2>
        {member && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> {t("add")}
          </Button>
        )}
      </div>
      {data && !data.hasRepository && <p className="rounded-md bg-warning/15 px-3 py-2 text-xs">{t("noRepository")}</p>}
      {building && (
        <p className="text-xs text-muted-foreground">
          <Hammer className="mr-1 inline size-3.5" aria-hidden />
          {t("buildingNow")}{" "}
          <Link href={`/tasks/${building.taskId}`} className="underline-offset-2 hover:underline">
            {building.title}
          </Link>
        </p>
      )}
      {!modules.length ? (
        <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          <Blocks className="mb-2 size-6" aria-hidden />
          <p>{t("empty")}</p>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {modules.map((m) => (
            <li key={m.id}>
              <ModuleCard m={m} selected={m.id === picked} onPick={() => setPicked(m.id === picked ? null : m.id)} />
            </li>
          ))}
        </ul>
      )}
      {shown && <ModuleDetail key={shown.id} app={app} moduleId={shown.id} admin={admin} member={member} hasRepository={!!data?.hasRepository} onClose={() => setPicked(null)} />}
      {adding && <AddModuleDialog app={app} onClose={() => setAdding(false)} onAdded={(id) => setPicked(id)} />}
    </section>
  );
}

function StatusChip({ status }: { status: ModuleStatus }) {
  const t = useTranslations("apps.modules");
  return <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide uppercase", STATUS_TONE[status])}>{t(`status.${status}`)}</span>;
}

function ModuleCard({ m, selected, onPick }: { m: ModuleView; selected: boolean; onPick: () => void }) {
  const t = useTranslations("apps.modules");
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "flex h-full w-full flex-col gap-1.5 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected && "border-foreground",
      )}
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{m.name}</span>
          <code className="block truncate font-mono text-[11px] text-muted-foreground">{m.slug}</code>
        </span>
        <StatusChip status={m.status} />
      </span>
      {m.summary && <span className="line-clamp-2 text-xs text-muted-foreground">{m.summary}</span>}
      <span className="mt-auto flex flex-wrap gap-1 text-[11px]">
        <span className="rounded bg-secondary px-1.5">{m.prd.approved ? t("prdVersion", { version: m.prd.approved.version }) : t("prdNone")}</span>
        {m.prd.draft && <span className="rounded bg-[var(--sign-biru)]/20 px-1.5 font-semibold">{t("prdDraft", { version: m.prd.draft.version })}</span>}
        {m.writingPrd && <span className="rounded bg-secondary px-1.5">{t("writingPrd")}</span>}
        {m.pending && <span className="rounded bg-warning/20 px-1.5">{t("waiting")}</span>}
        {m.inPreview && <span className="rounded bg-secondary px-1.5">{t("inPreview")}</span>}
        {m.inLive && <span className="rounded bg-success/15 px-1.5 text-success">{t("inLive")}</span>}
      </span>
    </button>
  );
}

function ModuleDetail({
  app,
  moduleId,
  admin,
  member,
  hasRepository,
  onClose,
}: {
  app: Pick<AppDTO, "id" | "name">;
  moduleId: string;
  admin: boolean;
  member: boolean;
  hasRepository: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("apps.modules");
  const f = useFormat();
  const qc = useQueryClient();
  const focusDoc = useSearchParams().get("doc");
  const key = ["app", app.id, "module", moduleId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ module: ModuleView; prd: PrdVersion[] }>(`/api/apps/${app.id}/modules/${moduleId}`) });
  const [picked, setPicked] = useState<string | null>(focusDoc);
  const [diff, setDiff] = useState(false);
  const [dialog, setDialog] = useState<"prd" | "build" | "change" | "register" | "import" | "edit" | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: modulesQueryKey(app.id) });
    void qc.invalidateQueries({ queryKey: ["approvals"] });
  };

  const m = data?.module;
  const versions = data?.prd ?? [];
  const shownId = picked && versions.some((v) => v.id === picked) ? picked : (versions.find((v) => v.status === "draft")?.id ?? versions.find((v) => v.status === "approved")?.id ?? versions[0]?.id ?? null);
  const { data: detail } = useQuery({ queryKey: ["app", app.id, "documents", shownId], queryFn: () => api.get<DocDetail>(`/api/apps/${app.id}/documents/${shownId}`), enabled: !!shownId });
  const doc = detail?.doc.id === shownId ? detail.doc : null;

  const decide = useMutation({
    mutationFn: (action: "approve" | "reject") => api.post(`/api/apps/${app.id}/documents/${shownId}`, { action }),
    onSuccess: (_r, action) => {
      toast.success(t(action === "approve" ? "prdApproved" : "prdRejected"));
      refresh();
    },
    onError,
  });
  const hold = useMutation({
    mutationFn: (h: "paused" | "dropped" | null) => api.patch(`/api/apps/${app.id}/modules/${moduleId}`, { hold: h }),
    onSuccess: refresh,
    onError,
  });
  const unqueue = useMutation({ mutationFn: () => api.del(`/api/apps/${app.id}/modules/${moduleId}/work`), onSuccess: refresh, onError });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/apps/${app.id}/modules/${moduleId}`),
    onSuccess: () => {
      toast.success(t("removed"));
      void qc.invalidateQueries({ queryKey: modulesQueryKey(app.id) });
      onClose();
    },
    onError,
  });

  if (!m) return null;
  const busy = !!m.active || !!m.pending;
  const hasWork = m.tasks.some((x) => x.role !== "prd");
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {m.name} <StatusChip status={m.status} />
          </h3>
          <code className="font-mono text-xs text-muted-foreground">{m.slug}</code>
          {m.summary && <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">{m.summary}</p>}
        </div>
        <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label={t("close")}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t(`explain.${m.status}`)}</p>

      {m.pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/15 px-3 py-2 text-xs">
          <span className="flex-1">{t("pending", { what: t(`role.${m.pending.role}`), at: f.ago(m.pending.requestedAt) })}</span>
          {admin && (
            <Button size="sm" variant="ghost" className="h-7" disabled={unqueue.isPending} onClick={() => unqueue.mutate()}>
              {t("unqueue")}
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {member && m.hold !== "dropped" && (
          <Button size="sm" variant="outline" disabled={m.writingPrd} onClick={() => setDialog("prd")}>
            {t(versions.length ? "askPrdUpdate" : "askPrd")}
          </Button>
        )}
        {admin && !m.hold && (
          <>
            <Button size="sm" className="gap-1.5" disabled={!m.prd.approved || !hasRepository || busy} title={!m.prd.approved ? t("needPrd") : undefined} onClick={() => setDialog("build")}>
              <Hammer className="size-3.5" aria-hidden /> {t(hasWork ? "rebuild" : "build")}
            </Button>
            <Button size="sm" variant="outline" disabled={!hasRepository || busy} onClick={() => setDialog("change")}>
              {t("change")}
            </Button>
          </>
        )}
        {admin && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDialog("register")} disabled={!hasRepository}>
              {t("register")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog("import")}>
              {t("importPrd")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog("edit")}>
              {t("edit")}
            </Button>
            {m.hold ? (
              <Button size="sm" variant="ghost" className="gap-1.5" disabled={hold.isPending} onClick={() => hold.mutate(null)}>
                <Play className="size-3.5" aria-hidden /> {t("resume")}
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" className="gap-1.5" disabled={hold.isPending} onClick={() => hold.mutate("paused")}>
                  <Pause className="size-3.5" aria-hidden /> {t("pause")}
                </Button>
                <Button size="sm" variant="ghost" disabled={hold.isPending} onClick={() => confirm(t("dropConfirm", { name: m.name })) && hold.mutate("dropped")}>
                  {t("drop")}
                </Button>
              </>
            )}
            {!hasWork && (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending} onClick={() => confirm(t("removeConfirm", { name: m.name })) && remove.mutate()}>
                {t("remove")}
              </Button>
            )}
          </>
        )}
      </div>

      {/* the module's PRD: versions, compared with the approved one, decided by an Admin */}
      <div className="space-y-2 rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{t("prd")}</span>
          {!!versions.length && (
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={shownId ?? ""}
              onChange={(e) => {
                setPicked(e.target.value);
                setDiff(false);
              }}
              aria-label={t("prdVersionPick")}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {t("versionOption", { version: v.version, status: t(`docStatus.${v.status}`) })}
                </option>
              ))}
            </select>
          )}
          {doc && <span className={cn("rounded px-1.5 text-[11px] font-bold uppercase", DOC_TONE[doc.status])}>{t(`docStatus.${doc.status}`)}</span>}
          {doc && <span className="text-xs text-muted-foreground">{[doc.author, f.ago(doc.createdAt)].filter(Boolean).join(" · ")}</span>}
          {detail?.approved && doc && doc.status !== "approved" && (
            <Button size="sm" variant={diff ? "secondary" : "ghost"} className="ml-auto h-8 gap-1.5" onClick={() => setDiff((d) => !d)}>
              <GitCompare className="size-3.5" aria-hidden /> {t("compare", { version: detail.approved.version })}
            </Button>
          )}
        </div>
        {!versions.length && <p className="text-sm text-muted-foreground">{m.writingPrd ? t("writingPrdLong") : t("prdEmpty")}</p>}
        {doc?.note && <p className="text-xs text-muted-foreground">{t("note", { note: doc.note })}</p>}
        {doc && diff && detail?.approved ? (
          <pre className="max-h-[60vh] overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">
            {lineDiff(detail.approved.content, doc.content).map((l, j) => (
              <div key={j} className={cn(l.op === "add" && "bg-success/15", l.op === "del" && "bg-destructive/15 line-through decoration-destructive/40")}>
                {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
                {l.text}
              </div>
            ))}
          </pre>
        ) : doc ? (
          <div className="max-h-[60vh] overflow-auto">
            <DocMarkdown md={doc.content} shot={() => null} />
          </div>
        ) : null}
        {admin && doc?.status === "draft" && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
              {t("approve", { version: doc.version })}
            </Button>
            <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => confirm(t("rejectConfirm")) && decide.mutate("reject")}>
              {t("reject")}
            </Button>
          </div>
        )}
      </div>

      {/* what was done for it: tasks (PRD, builds, changes, registered work) and what they pushed */}
      {(!!m.tasks.length || !!m.work.length) && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("tasks")}</h4>
            <ul className="space-y-1 text-sm">
              {m.tasks.map((x) => (
                <li key={x.taskId} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{t(`role.${x.role}`)}</span>
                  <Link href={`/tasks/${x.taskId}`} className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">
                    {x.title}
                  </Link>
                  <span className="text-[11px] text-muted-foreground">{x.status}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("work")}</h4>
            {!m.work.length && <p className="text-sm text-muted-foreground">{t("noWork")}</p>}
            <ul className="space-y-1 text-sm">
              {m.work.map((w) => (
                <li key={`${w.taskId}:${w.head}`} className="flex items-center gap-2">
                  <code className="font-mono text-[11px]">{w.head.slice(0, 7)}</code>
                  <Link href={`/tasks/${w.taskId}?tab=code`} className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">
                    {w.title}
                  </Link>
                  <span className="text-[11px] text-muted-foreground">{t(`merge.${w.state}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {dialog === "prd" && <AskPrdDialog app={app} m={m} onClose={() => setDialog(null)} onDone={refresh} />}
      {(dialog === "build" || dialog === "change") && <WorkDialog app={app} m={m} role={dialog} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "register" && <RegisterDialog app={app} m={m} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "import" && <ImportPrdDialog app={app} m={m} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "edit" && <EditModuleDialog app={app} m={m} slugFixed={hasWork} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function useWriters() {
  const { data: employees } = useEmployees();
  return useMemo(
    () => [...(employees ?? [])].filter((e) => e.status !== "ARCHIVED").sort((a, b) => Number(WRITER_RE.test(b.role)) - Number(WRITER_RE.test(a.role)) || a.name.localeCompare(b.name)),
    [employees],
  );
}

function AddModuleDialog({ app, onClose, onAdded }: { app: Pick<AppDTO, "id" | "name">; onClose: () => void; onAdded: (id: string) => void }) {
  const t = useTranslations("apps.modules");
  const qc = useQueryClient();
  const writers = useWriters();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [writerId, setWriterId] = useState<string>("auto");
  const writer = writerId === "auto" ? writers[0]?.id : writerId === "none" ? undefined : writerId;
  const add = useMutation({
    mutationFn: () => api.post<{ id: string; taskId: string | null }>(`/api/apps/${app.id}/modules`, { name, ...(slug ? { slug } : {}), summary, ...(writer ? { writerId: writer } : {}) }),
    onSuccess: (r) => {
      toast.success(t(r.taskId ? "addedWriting" : "added"));
      void qc.invalidateQueries({ queryKey: modulesQueryKey(app.id) });
      onAdded(r.id);
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addTitle", { app: app.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="mod-name">{t("name")}</Label>
            <Input id="mod-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mod-slug">{t("slug")}</Label>
            <Input id="mod-slug" value={slug} maxLength={40} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder={t("slugPlaceholder")} className="font-mono" />
            <p className="text-xs text-muted-foreground">{t("slugHelp")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="mod-summary">{t("summary")}</Label>
            <Textarea id="mod-summary" rows={4} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} placeholder={t("summaryPlaceholder")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mod-writer">{t("writer")}</Label>
            <select id="mod-writer" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={writerId} onChange={(e) => setWriterId(e.target.value)}>
              <option value="auto">{writers[0] ? t("writerAuto", { name: writers[0].name }) : t("writerNone")}</option>
              {writers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
              <option value="none">{t("writerLater")}</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={add.isPending || name.trim().length < 2} onClick={() => add.mutate()}>
            {t("addNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AskPrdDialog({ app, m, onClose, onDone }: { app: Pick<AppDTO, "id">; m: ModuleView; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.modules");
  const writers = useWriters();
  const [employeeId, setEmployeeId] = useState("");
  const [note, setNote] = useState("");
  const ask = useMutation({
    mutationFn: () => api.post(`/api/apps/${app.id}/modules/${m.id}/prd`, { employeeId: employeeId || writers[0]?.id, note }),
    onSuccess: () => {
      toast.success(t("prdAsked"));
      onDone();
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("askPrdTitle", { name: m.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("askPrdExplain")}</p>
          <div className="space-y-1">
            <Label htmlFor="prd-writer">{t("writer")}</Label>
            <select id="prd-writer" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={employeeId || writers[0]?.id || ""} onChange={(e) => setEmployeeId(e.target.value)}>
              {writers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="prd-note">{t("askNote")}</Label>
            <Textarea id="prd-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={ask.isPending || !writers.length} onClick={() => ask.mutate()}>
            {t("askNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkDialog({ app, m, role, onClose, onDone }: { app: Pick<AppDTO, "id">; m: ModuleView; role: "build" | "change"; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.modules");
  const { data: employees } = useEmployees();
  const { data: teams } = useTeams();
  // only who can change code: Workspace-mode employees, divisions with a code lead
  const builders = useMemo(() => (employees ?? []).filter((e) => e.status !== "ARCHIVED" && e.executionMode === "workspace").sort((a, b) => a.name.localeCompare(b.name)), [employees]);
  const codeDivisions = (teams ?? []).filter((d) => d.codeLeadId);
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const pick = who || (builders[0] ? `e:${builders[0].id}` : "");
  const work = useMutation({
    mutationFn: () =>
      api.post<{ taskId: string | null; waitingFor: string | null }>(`/api/apps/${app.id}/modules/${m.id}/work`, {
        role,
        note,
        ...(pick.startsWith("t:") ? { teamId: pick.slice(2) } : { employeeId: pick.slice(2) }),
      }),
    onSuccess: (r) => {
      toast.success(r.taskId ? t("workStarted") : t("workQueued", { task: r.waitingFor ?? "" }));
      onDone();
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(role === "build" ? "buildTitle" : "changeTitle", { name: m.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t(role === "build" ? "buildExplain" : "changeExplain", { version: m.prd.approved?.version ?? 0 })}</p>
          <div className="space-y-1">
            <Label htmlFor="work-who">{t("builder")}</Label>
            <select id="work-who" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={pick} onChange={(e) => setWho(e.target.value)}>
              <optgroup label={t("employees")}>
                {builders.map((e) => (
                  <option key={e.id} value={`e:${e.id}`}>
                    {e.name} — {e.role}
                  </option>
                ))}
              </optgroup>
              {!!codeDivisions.length && (
                <optgroup label={t("divisions")}>
                  {codeDivisions.map((d) => (
                    <option key={d.id} value={`t:${d.id}`}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="work-note">{t(role === "build" ? "buildNote" : "changeNote")}</Label>
            <Textarea id="work-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={work.isPending || !pick || (role === "change" && note.trim().length < 5)} onClick={() => work.mutate()}>
            {t(role === "build" ? "buildNow" : "changeNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegisterDialog({ app, m, onClose, onDone }: { app: Pick<AppDTO, "id">; m: ModuleView; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.modules");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["app", app.id, "module", m.id, "register"],
    queryFn: () => api.get<{ candidates: { taskId: string; title: string; branch: string; head: string; pushedAt: string; state: ModuleView["work"][number]["state"] }[] }>(`/api/apps/${app.id}/modules/${m.id}/register`),
  });
  const reg = useMutation({
    mutationFn: (taskId: string) => api.post(`/api/apps/${app.id}/modules/${m.id}/register`, { taskId }),
    onSuccess: () => {
      toast.success(t("registered"));
      onDone();
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("registerTitle", { name: m.name })}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("registerExplain")}</p>
        {!data?.candidates.length && <p className="text-sm text-muted-foreground">{t("registerNone")}</p>}
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {data?.candidates.map((c) => (
            <li key={c.taskId}>
              <button type="button" disabled={reg.isPending} onClick={() => reg.mutate(c.taskId)} className="w-full rounded-lg p-2 text-left text-sm hover:bg-secondary">
                <span className="block font-medium">{c.title}</span>
                <span className="block text-xs text-muted-foreground">
                  <code className="font-mono">{c.head.slice(0, 7)}</code> · {t(`merge.${c.state}`)} · {f.ago(c.pushedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function ImportPrdDialog({ app, m, onClose, onDone }: { app: Pick<AppDTO, "id">; m: ModuleView; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.modules");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["app", app.id, "prd-candidates"],
    queryFn: () => api.get<{ candidates: { taskId: string; taskTitle: string; deliverableId: string; title: string; createdAt: string }[] }>(`/api/apps/${app.id}/documents/import`),
  });
  const imp = useMutation({
    mutationFn: (c: { taskId: string; deliverableId: string }) => api.post<{ version: number }>(`/api/apps/${app.id}/modules/${m.id}/prd/import`, c),
    onSuccess: (r) => {
      toast.success(t("imported", { version: r.version }));
      onDone();
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("importTitle", { name: m.name })}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("importExplain")}</p>
        {!data?.candidates.length && <p className="text-sm text-muted-foreground">{t("importNone")}</p>}
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {data?.candidates.map((c) => (
            <li key={`${c.taskId}:${c.deliverableId}`}>
              <button type="button" disabled={imp.isPending} onClick={() => imp.mutate(c)} className="w-full rounded-lg p-2 text-left text-sm hover:bg-secondary">
                <span className="block font-medium">{c.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {c.taskTitle} · {f.ago(c.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function EditModuleDialog({ app, m, slugFixed, onClose, onDone }: { app: Pick<AppDTO, "id">; m: ModuleView; slugFixed: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.modules");
  const [name, setName] = useState(m.name);
  const [slug, setSlug] = useState(m.slug);
  const [summary, setSummary] = useState(m.summary);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/apps/${app.id}/modules/${m.id}`, { name, summary, ...(slugFixed || slug === m.slug ? {} : { slug }) }),
    onSuccess: () => {
      toast.success(t("saved"));
      onDone();
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTitle", { name: m.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="edit-name">{t("name")}</Label>
            <Input id="edit-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-slug">{t("slug")}</Label>
            <Input id="edit-slug" value={slug} maxLength={40} disabled={slugFixed} onChange={(e) => setSlug(e.target.value.toLowerCase())} className="font-mono" />
            {slugFixed && <p className="text-xs text-muted-foreground">{t("slugFixed")}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-summary">{t("summary")}</Label>
            <Textarea id="edit-summary" rows={4} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending || name.trim().length < 2} onClick={() => save.mutate()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
