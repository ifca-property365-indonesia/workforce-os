"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, GitCompare, Presentation, Printer } from "lucide-react";
import Link, { useSearchParams } from "@/lib/nav";
import type { AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { lineDiff, splitSlides } from "@/lib/doc-format";
import { useEmployees } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { DocMarkdown } from "./doc-markdown";

type Kind = "prd" | "flow" | "test_guide" | "deck";
const KINDS: Kind[] = ["prd", "flow", "test_guide", "deck"];
interface VersionRow {
  id: string;
  kind: Kind;
  version: number;
  title: string;
  status: "draft" | "approved" | "superseded" | "rejected";
  note: string;
  basedOnVersion: number | null;
  taskId: string | null;
  author: string | null;
  createdAt: string;
  decidedAt: string | null;
}
type Docs = Record<Kind, { versions: VersionRow[]; approved: { id: string; version: number } | null; releasesSinceApproved: number }>;
interface DocDetail {
  doc: VersionRow & { content: string; testId: string | null };
  approved: { id: string; version: number; content: string } | null;
}
const STATUS_TONE: Record<VersionRow["status"], string> = { draft: "bg-[var(--sign-biru)]/15", approved: "bg-success/15 text-success", superseded: "bg-muted text-muted-foreground", rejected: "bg-destructive/15 text-destructive" };
/** writers first: roles that write documents (project, product, analyst, marketing) */
const WRITER_RE = /\b(project|product|pm|analyst|analis|marketing|writer|penulis|bisnis|business)\b/i;

/**
 * C9: the app's documents. Each kind has versions; a new version is a draft next to the approved one, compared line
 * by line, approved or rejected by an Admin. Members ask an employee for a new version (a task that may write exactly
 * that document). A presentation shows as slides with the screenshots of its app test, and prints to PDF.
 */
export function AppDocumentsPanel({ app, admin, member }: { app: Pick<AppDTO, "id" | "name">; admin: boolean; member: boolean }) {
  const t = useTranslations("apps.docs");
  const f = useFormat();
  const qc = useQueryClient();
  const focusDoc = useSearchParams().get("doc");
  const key = ["app", app.id, "documents"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ kinds: Docs }>(`/api/apps/${app.id}/documents`).then((r) => r.kinds) });
  const [kind, setKind] = useState<Kind>("prd");
  const [picked, setPicked] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [asking, setAsking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [presenting, setPresenting] = useState(false);

  // a link from Needs a decision opens that version
  useEffect(() => {
    if (!focusDoc || !data) return;
    for (const k of KINDS) if (data[k].versions.some((v) => v.id === focusDoc)) {
      setKind(k);
      setPicked(focusDoc);
      document.getElementById("app-docs-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusDoc, data]);

  const cur = data?.[kind];
  const shownId = picked && cur?.versions.some((v) => v.id === picked) ? picked : (cur?.versions.find((v) => v.status === "draft")?.id ?? cur?.approved?.id ?? cur?.versions[0]?.id ?? null);
  const { data: detail } = useQuery({ queryKey: [...key, shownId], queryFn: () => api.get<DocDetail>(`/api/apps/${app.id}/documents/${shownId}`), enabled: !!shownId });
  const doc = detail?.doc.id === shownId ? detail.doc : null;
  const shot = (n: number) => (doc?.testId ? `/api/apps/${app.id}/tests/${doc.testId}/screenshots/${n}` : null);

  const decide = useMutation({
    mutationFn: (action: "approve" | "reject") => api.post(`/api/apps/${app.id}/documents/${shownId}`, { action }),
    onSuccess: (_r, action) => {
      toast.success(t(action === "approve" ? "approved" : "rejected"));
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <section className="space-y-3" aria-labelledby="app-docs-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="app-docs-title" className="font-display flex-1 text-[1.7rem] leading-none">
          {t("title")}
        </h2>
        {member && (
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
            {t(cur?.versions.length ? "askUpdate" : "askFirst", { doc: t(`kind.${kind}`) })}
          </Button>
        )}
        {admin && kind === "prd" && (
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
            {t("importPrd")}
          </Button>
        )}
      </div>
      <div role="tablist" aria-label={t("title")} className="flex flex-wrap gap-1">
        {KINDS.map((k) => {
          const drafts = data?.[k].versions.filter((v) => v.status === "draft").length ?? 0;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => {
                setKind(k);
                setPicked(null);
                setDiff(false);
              }}
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm", kind === k ? "bg-secondary font-semibold" : "text-muted-foreground hover:bg-secondary/60")}
            >
              {t(`kind.${k}`)}
              {!!drafts && <span className="rounded-full bg-[var(--sign-biru)]/20 px-1.5 text-[11px] font-bold">{drafts}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="space-y-3 rounded-xl border bg-card p-4">
        {kind === "prd" && !!cur?.releasesSinceApproved && <p className="rounded-md bg-warning/15 px-3 py-2 text-xs">{t("prdStale", { count: cur.releasesSinceApproved })}</p>}
        {!cur?.versions.length && (
          <p className="text-sm text-muted-foreground">
            <FileText className="mr-1.5 inline size-4" aria-hidden />
            {t(`empty.${kind}`)}
          </p>
        )}
        {!!cur?.versions.length && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="h-8 rounded-md border bg-background px-2 text-sm" value={shownId ?? ""} onChange={(e) => setPicked(e.target.value)} aria-label={t("version")}>
              {cur.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {t("versionOption", { version: v.version, status: t(`status.${v.status}`) })}
                </option>
              ))}
            </select>
            {doc && <span className={cn("rounded px-1.5 text-[11px] font-bold uppercase", STATUS_TONE[doc.status])}>{t(`status.${doc.status}`)}</span>}
            {doc && <span className="text-xs text-muted-foreground">{[doc.author, f.ago(doc.createdAt), doc.basedOnVersion ? t("basedOn", { version: doc.basedOnVersion }) : ""].filter(Boolean).join(" · ")}</span>}
            {doc?.taskId && (
              <Link href={`/tasks/${doc.taskId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                {t("openTask")}
              </Link>
            )}
            <span className="ml-auto flex gap-1.5">
              {detail?.approved && doc && doc.status !== "approved" && (
                <Button size="sm" variant={diff ? "secondary" : "ghost"} className="h-8 gap-1.5" onClick={() => setDiff((d) => !d)}>
                  <GitCompare className="size-3.5" aria-hidden /> {t("compare", { version: detail.approved.version })}
                </Button>
              )}
              {kind === "deck" && doc && (
                <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => setPresenting(true)}>
                  <Presentation className="size-3.5" aria-hidden /> {t("present")}
                </Button>
              )}
            </span>
          </div>
        )}
        {doc?.note && <p className="text-xs text-muted-foreground">{t("note", { note: doc.note })}</p>}
        {doc && diff && detail?.approved ? (
          <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed">
            {lineDiff(detail.approved.content, doc.content).map((l, j) => (
              <div key={j} className={cn(l.op === "add" && "bg-success/15", l.op === "del" && "bg-destructive/15 line-through decoration-destructive/40")}>
                {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
                {l.text}
              </div>
            ))}
          </pre>
        ) : doc && kind === "deck" ? (
          <div className="grid gap-3 md:grid-cols-2">
            {splitSlides(doc.content).map((s, j) => (
              <div key={j} className="aspect-[16/10] overflow-hidden rounded-lg border bg-background p-4">
                <DocMarkdown md={s} shot={shot} className="[&_img]:max-h-40" />
              </div>
            ))}
          </div>
        ) : doc ? (
          <div className="max-h-[70vh] overflow-auto">
            <DocMarkdown md={doc.content} shot={shot} />
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

      {asking && <AskDialog app={app} kind={kind} onClose={() => setAsking(false)} onDone={() => void qc.invalidateQueries({ queryKey: key })} />}
      {importing && <ImportDialog app={app} onClose={() => setImporting(false)} onDone={() => void qc.invalidateQueries({ queryKey: key })} />}
      {presenting && doc && (
        <Dialog open onOpenChange={(o) => !o && setPresenting(false)}>
          <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{doc.title}</DialogTitle>
            </DialogHeader>
            <div className="print-deck space-y-4">
              {splitSlides(doc.content).map((s, j) => (
                <div key={j} className="deck-slide flex aspect-[16/9] flex-col justify-center overflow-hidden rounded-xl border bg-background p-8">
                  <DocMarkdown md={s} shot={shot} className="text-base [&_h2]:text-[2.2rem] [&_img]:max-h-72" />
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" className="gap-1.5" onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden /> {t("print")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function AskDialog({ app, kind, onClose, onDone }: { app: Pick<AppDTO, "id" | "name">; kind: Kind; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.docs");
  const { data: employees } = useEmployees();
  const writers = useMemo(() => [...(employees ?? [])].filter((e) => e.status !== "ARCHIVED").sort((a, b) => Number(WRITER_RE.test(b.role)) - Number(WRITER_RE.test(a.role)) || a.name.localeCompare(b.name)), [employees]);
  const [employeeId, setEmployeeId] = useState("");
  const [note, setNote] = useState("");
  const ask = useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`/api/apps/${app.id}/documents/request`, { kind, employeeId: employeeId || writers[0]?.id, note }),
    onSuccess: () => {
      toast.success(t("asked"));
      onDone();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("askTitle", { doc: t(`kind.${kind}`), app: app.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t(`askExplain.${kind}`)}</p>
          <div className="space-y-1">
            <Label htmlFor="doc-writer">{t("writer")}</Label>
            <select id="doc-writer" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={employeeId || writers[0]?.id || ""} onChange={(e) => setEmployeeId(e.target.value)}>
              {writers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="doc-note">{t("askNote")}</Label>
            <Textarea id="doc-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
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

function ImportDialog({ app, onClose, onDone }: { app: Pick<AppDTO, "id">; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("apps.docs");
  const f = useFormat();
  const { data } = useQuery({ queryKey: ["app", app.id, "prd-candidates"], queryFn: () => api.get<{ candidates: { taskId: string; taskTitle: string; deliverableId: string; title: string; createdAt: string }[] }>(`/api/apps/${app.id}/documents/import`) });
  const imp = useMutation({
    mutationFn: (c: { taskId: string; deliverableId: string }) => api.post<{ version: number }>(`/api/apps/${app.id}/documents/import`, c),
    onSuccess: (r) => {
      toast.success(t("imported", { version: r.version }));
      onDone();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("importPrd")}</DialogTitle>
        </DialogHeader>
        {!data?.candidates.length && <p className="text-sm text-muted-foreground">{t("noCandidates")}</p>}
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
