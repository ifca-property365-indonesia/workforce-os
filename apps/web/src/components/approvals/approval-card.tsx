"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Clock, FlaskConical, History, Pencil, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Avatar } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { PayloadPreview } from "./payload-preview";
import { resultSummary, type Approval } from "./types";

type Decision = { decision: "approve" | "edit_approve" | "reject"; editedPayload?: Record<string, unknown>; feedback?: string };

function statusClass(status: string): string {
  if (status === "PENDING") return "bg-amber-500/15 text-amber-700";
  if (status === "REJECTED" || status === "FAILED") return "bg-destructive/15 text-destructive";
  if (status === "EXPIRED") return "bg-muted text-muted-foreground";
  if (status === "EXECUTING") return "bg-sky-500/15 text-sky-700";
  return "bg-emerald-500/15 text-emerald-700";
}

type Finding = NonNullable<Approval["guardFindings"]>[number];

/**
 * Input/output guard findings (possible leak / injection) recorded when the approval was raised. One component for
 * the inbox and the chat, so an admin always sees them before deciding: the inbox lists them in full; the chat card
 * (`collapsible`) folds low/medium findings behind a visible summary line but always lists high-severity ones.
 */
export function GuardFindings({ findings, collapsible = false }: { findings: readonly Finding[]; collapsible?: boolean }) {
  const t = useTranslations("approvals");
  if (!findings.length) return null;
  const high = findings.some((g) => g.severity === "high");
  const severity = (s: string) => (t.has(`card.severity.${s}`) ? t(`card.severity.${s}`) : s);
  const heading = (
    <>
      <ShieldAlert className="size-3.5 shrink-0" /> {t("card.guardFindings")}
      <span className="font-normal opacity-80">· {t("card.guardFindingsCount", { count: findings.length })}</span>
    </>
  );
  const list = (
    <ul className="mt-1 space-y-0.5">
      {findings.map((g, i) => (
        <li key={`${g.rule}-${i}`} className="break-words">
          <span className={cn("font-medium", g.severity === "high" && "uppercase")}>{severity(g.severity)}</span> · {g.rule}
          {g.excerpt && <> · <span className="font-mono">{g.excerpt}</span></>}
        </li>
      ))}
    </ul>
  );
  const box = cn("rounded-md p-2 text-xs", high ? "border border-destructive/40 bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-800 dark:text-amber-300");
  if (collapsible && !high) {
    return (
      <details className={box}>
        <summary className="flex cursor-pointer items-center gap-1 font-medium">{heading}</summary>
        {list}
      </details>
    );
  }
  return (
    <div className={box}>
      <div className="flex items-center gap-1 font-medium">{heading}</div>
      {list}
    </div>
  );
}

export function ApprovalStatusPill({ status, className }: { status: string; className?: string }) {
  const ts = useTranslations("status");
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", statusClass(status), className)}>{ts(`approval.${status}`)}</span>;
}

/**
 * One approval with its exact payload and the Approve / Edit & approve / Reject decision.
 * `compact` is the chat variant (smaller header, collapsible preview); `readOnly` replaces the buttons with a
 * "waiting for an admin" note for users who cannot decide (the decide route is ADMIN-only either way).
 */
export function ApprovalCard({ a, focused = false, compact = false, readOnly = false }: { a: Approval; focused?: boolean; compact?: boolean; readOnly?: boolean }) {
  const qc = useQueryClient();
  const t = useTranslations("approvals");
  const tc = useTranslations("common");
  const f = useFormat();
  const pending = a.status === "PENDING";
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>(a.payload);
  /**
   * compact: an admin sees what they are approving straight away; everything else starts folded. Derived until the
   * user toggles, so it follows `readOnly` once the signed-in user (and so their role) has loaded.
   */
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? (pending && !readOnly);
  // decided elsewhere (inbox, another admin): drop a half-done edit or rejection
  useEffect(() => {
    if (pending) return;
    setEditing(false);
    setRejecting(false);
  }, [pending]);
  const decide = useMutation({
    mutationFn: (body: Decision) => api.post(`/api/approvals/${a.id}/decide`, body),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "reject" ? t("card.rejected") : t("card.approved"));
      setEditing(false);
      setRejecting(false);
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["conversation"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const simulated = a.task?.dryRun || a.task?.source === "demo";
  const toolLabel = t.has(`tools.${a.toolName}`) ? t(`tools.${a.toolName}`) : a.toolName;
  const summary = resultSummary(a);

  const details = (
    <>
      {simulated && (
        <div className="flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
          <FlaskConical className="size-3.5" /> {t("card.dryRunNotice")}
        </div>
      )}
      {!compact && <GuardFindings findings={a.guardFindings ?? []} />}
      <PayloadPreview a={a} editing={editing} draft={draft} setDraft={setDraft} />
      {a.editedPayload && !pending && <p className="text-xs text-muted-foreground">{t("card.editedByHuman")}</p>}
    </>
  );

  const outcome = (
    <>
      {a.feedback && <p className="text-xs text-muted-foreground">{t("card.feedback", { feedback: a.feedback })}</p>}
      {summary && <p className="text-xs text-muted-foreground">{t("card.result", { summary })}</p>}
    </>
  );

  let actions: ReactNode = null;
  if (pending && readOnly) {
    actions = (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" /> {t("card.waitingForAdmin")}
      </p>
    );
  } else if (pending) {
    const size = compact ? "xs" : "sm";
    actions = rejecting ? (
      <div className="space-y-2">
        <Textarea placeholder={t("card.rejectPlaceholder")} value={feedback} onChange={(e) => setFeedback(e.target.value)} className={cn(compact && "min-h-16 text-xs")} />
        <div className="flex gap-2">
          <Button variant="destructive" size={size} onClick={() => decide.mutate({ decision: "reject", feedback })} disabled={decide.isPending}>
            {t("card.rejectWithFeedback")}
          </Button>
          <Button variant="ghost" size={size} onClick={() => setRejecting(false)}>
            {tc("cancel")}
          </Button>
        </div>
      </div>
    ) : editing ? (
      <div className="flex gap-2">
        <Button size={size} onClick={() => decide.mutate({ decision: "edit_approve", editedPayload: draft })} disabled={decide.isPending} className="gap-1">
          <Check className="size-3.5" /> {t("card.saveAndApprove")}
        </Button>
        <Button variant="ghost" size={size} onClick={() => (setEditing(false), setDraft(a.payload))}>
          {tc("cancel")}
        </Button>
      </div>
    ) : (
      <div className="flex flex-wrap gap-2">
        <Button size={size} onClick={() => decide.mutate({ decision: "approve" })} disabled={decide.isPending} className="gap-1">
          <ShieldCheck className="size-3.5" /> {t("card.approve")}
        </Button>
        {a.toolName !== "git_push" && (
          <Button size={size} variant="outline" onClick={() => (setEditing(true), setOpen(true))} className="gap-1">
            <Pencil className="size-3.5" /> {t("card.editAndApprove")}
          </Button>
        )}
        <Button size={size} variant="outline" onClick={() => setRejecting(true)} className="gap-1 text-destructive">
          <X className="size-3.5" /> {t("card.reject")}
        </Button>
      </div>
    );
  }

  if (compact) {
    const detailsId = `approval-details-${a.id}`;
    return (
      <div id={a.id} className={cn("rounded-lg border bg-card text-left", pending && "border-amber-500/50", focused && "ring-2 ring-primary")}>
        <div className="flex items-center gap-2 px-3 py-2">
          {pending ? <ShieldAlert className="size-4 shrink-0 text-amber-600" /> : <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{a.title}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {toolLabel} · {f.ago(a.createdAt)}
            </div>
          </div>
          <ApprovalStatusPill status={a.status} className="text-[11px]" />
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? t("card.hideDetails") : t("card.showDetails")}
            title={open ? t("card.hideDetails") : t("card.showDetails")}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
        </div>
        {pending && a.reason && <div className="-mt-1 px-3 pb-2 text-[11px] text-amber-700 dark:text-amber-300">{a.reason}</div>}
        {open && (
          <div id={detailsId} className="space-y-2 border-t px-3 py-2">
            {details}
          </div>
        )}
        {/* never folded away with the details: always visible, and listed in full right above the buttons when high */}
        {!!a.guardFindings?.length && (
          <div className="border-t px-3 py-2">
            <GuardFindings findings={a.guardFindings} collapsible />
          </div>
        )}
        {!pending && (a.feedback || summary) && <div className="space-y-0.5 border-t px-3 py-1.5">{outcome}</div>}
        {actions && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <div className="min-w-0 flex-1">{actions}</div>
            {pending && (
              <Link href={`/approvals?focus=${a.id}`} className="text-[11px] text-primary hover:underline">
                {t("card.openInInbox")}
              </Link>
            )}
          </div>
        )}
      </div>
    );
  }

  const who = a.employee ? `${a.employee.name} (${a.employee.role})` : tc("unknown");
  return (
    <Card id={a.id} className={cn(focused && "ring-2 ring-primary")}>
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <Avatar emoji={a.employee?.avatar} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{a.title}</div>
          <div className="text-xs text-muted-foreground">
            {t.rich("card.wantsToRun", { employee: who, tool: toolLabel, code: (c) => <span className="font-medium text-foreground">{c}</span> })} · {f.ago(a.createdAt)}
            {a.task && (
              <>
                {" "}
                · {t("card.task")}{" "}
                <Link href={`/tasks/${a.task.id}`} className="text-primary hover:underline">
                  {a.task.title}
                </Link>
              </>
            )}
          </div>
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{a.reason}</div>
          {a.olderVersion && (
            <div className="mt-1">
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <History className="size-3" aria-hidden /> {t("card.olderVersion")}
              </span>
            </div>
          )}
        </div>
        <ApprovalStatusPill status={a.status} />
      </CardHeader>
      <CardContent className="space-y-3">
        {details}
        {outcome}
        {actions && <div className="space-y-2 border-t pt-3">{actions}</div>}
      </CardContent>
    </Card>
  );
}
