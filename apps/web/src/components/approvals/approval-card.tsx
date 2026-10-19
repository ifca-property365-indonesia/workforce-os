"use client";

import Link from "@/lib/nav";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Clock, Crown, FlaskConical, History, Pencil, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Avatar } from "@/components/layout/common";
import { useStepUp } from "@/components/account/step-up";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { PayloadPreview } from "./payload-preview";
import { useReleaseApprovalWindow } from "./release-approval";
import { resultSummary, type Approval } from "./types";

const DEMO_SUFFIX = " Demo: executes as a dry run.";
/** approved for one exact commit: approve or reject, never Edit & approve (decideApproval refuses it too) */
const NOT_EDITABLE: ReadonlySet<string> = new Set(["git_push", "request_preview", "request_release", "install_skill"]);
/** decided by the Owner only, with a fresh step-up (a LIVE release): decideApproval refuses anyone else */
const OWNER_ONLY: ReadonlySet<string> = new Set(["request_release"]);

/**
 * The gate writes its reason in English (packages/shared decideGate/screen). The known reasons are shown in the
 * reader's language; anything else (an older or custom reason) is shown as written.
 */
export function useReasonText(): (reason: string) => string {
  const t = useTranslations("approvals");
  const ts = useTranslations("status");
  return (reason) => {
    const demo = reason.endsWith(DEMO_SUFFIX);
    const r = demo ? reason.slice(0, -DEMO_SUFFIX.length) : reason;
    const level = /^Irreversible action requires approval \(autonomy (\w+)\)\.$/.exec(r)?.[1];
    let text: string | null = null;
    if (level) text = t("reasons.autonomy", { level: ts.has(`autonomy.${level}`) ? ts(`autonomy.${level}`) : level });
    else if (r === "Irreversible action outside the Owner allow-list requires approval.") text = t("reasons.allowList");
    else if (r === "Output guard found possible secrets/PII in the payload.") text = t("reasons.leak");
    else if (r.startsWith("This run handled untrusted content")) text = t("reasons.taint");
    if (!text) return reason;
    return demo ? `${text} ${t("reasons.demoDryRun")}` : text;
  };
}

type Decision = { decision: "approve" | "edit_approve" | "reject"; editedPayload?: Record<string, unknown>; feedback?: string };

function statusClass(status: string): string {
  if (status === "PENDING") return "bg-approval text-approval-ink";
  if (status === "REJECTED" || status === "FAILED") return "bg-destructive/15 text-destructive";
  if (status === "EXPIRED") return "bg-muted text-muted-foreground";
  if (status === "EXECUTING") return "bg-[var(--sign-biru)]/20 text-foreground";
  return "bg-success/15 text-success";
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
  const box = cn("rounded-lg p-2 text-xs", high ? "border border-destructive/40 bg-destructive/10 text-destructive" : "bg-warning/10 text-warning");
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
  const reasonText = useReasonText();
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
  const withStepUp = useStepUp();
  const { data: me } = useMe();
  const ownerOnly = OWNER_ONLY.has(a.toolName);
  // a LIVE release outside its window, older than a day or made against another LIVE commit is refused: Approve waits (Reject never does)
  const releaseWindow = useReleaseApprovalWindow(a);
  const decide = useMutation({
    mutationFn: (body: Decision) => {
      const send = () => api.post<{ ok: true }>(`/api/approvals/${a.id}/decide`, body);
      return ownerOnly ? withStepUp(send) : send();
    },
    onSuccess: (r, v) => {
      // the step-up was cancelled: nothing was decided
      if (!r) return;
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
        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--sign-ungu)] dark:text-[color-mix(in_srgb,var(--sign-ungu)_55%,white)]">
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
  if (pending && ownerOnly && me && me.role !== "OWNER") {
    actions = (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Crown className="size-3.5 shrink-0" aria-hidden /> {t("card.waitingForOwner")}
      </p>
    );
  } else if (pending && readOnly) {
    actions = (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" /> {t("card.waitingForAdmin")}
      </p>
    );
  } else if (pending) {
    const size = "sm";
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
        <Button
          size={size}
          onClick={() => decide.mutate({ decision: "approve" })}
          disabled={decide.isPending || releaseWindow.blocked}
          className={cn("gap-1", ownerOnly && "bg-[var(--sign-merah)] text-white hover:bg-[color-mix(in_srgb,var(--sign-merah)_86%,black)]")}
        >
          <ShieldCheck className="size-3.5" /> {ownerOnly ? t("card.approveRelease") : t("card.approve")}
        </Button>
        {!NOT_EDITABLE.has(a.toolName) && (
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
      <div id={a.id} className={cn("overflow-hidden rounded-xl border bg-card text-left", pending && "border-approval/50 shadow-[0_22px_40px_-26px_rgb(0_0_0/0.7)]", focused && "ring-2 ring-ring")}>
        {pending ? (
          <div className="approval-strip flex items-center gap-2 px-3.5 py-2">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            <span className="font-display flex-1 text-[1.2rem] tracking-[0.03em]">{t("card.stripPending")}</span>
            <span className="text-xs font-semibold">{f.ago(a.createdAt)}</span>
          </div>
        ) : null}
        <div className="flex items-start gap-2 px-3.5 pb-2 pt-3">
          {!pending && <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className={cn("break-words", pending ? "font-display mb-1 text-[1.45rem] normal-case !leading-[1.08] tracking-[0.005em]" : "text-sm font-semibold")}>{a.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {toolLabel}
              {!pending && <> · {f.ago(a.createdAt)}</>}
            </div>
          </div>
          {!pending && <ApprovalStatusPill status={a.status} className="text-[11px]" />}
          <button
            type="button"
            className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? t("card.hideDetails") : t("card.showDetails")}
            title={open ? t("card.hideDetails") : t("card.showDetails")}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
        </div>
        {pending && a.reason && (
          <div className="flex items-start gap-1.5 px-3.5 pb-2.5 text-xs font-semibold text-destructive">
            <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {reasonText(a.reason)}
          </div>
        )}
        {open && (
          <div id={detailsId} className="space-y-2 border-t px-3.5 py-3">
            {details}
          </div>
        )}
        {/* never folded away with the details: always visible, and listed in full right above the buttons when high */}
        {!!a.guardFindings?.length && (
          <div className="border-t px-3.5 py-2">
            <GuardFindings findings={a.guardFindings} collapsible />
          </div>
        )}
        {!pending && (a.feedback || summary) && <div className="space-y-0.5 border-t px-3.5 py-2">{outcome}</div>}
        {actions && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3.5 py-3">
            <div className="min-w-0 flex-1">{actions}</div>
            {pending && (
              <Link href={`/approvals?focus=${a.id}`} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
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
    <Card id={a.id} className={cn("gap-0 overflow-hidden py-0", pending && "border-approval/50", focused && "ring-2 ring-ring")}>
      {pending && (
        <div className="approval-strip flex items-center gap-2 px-5 py-2.5">
          <ShieldAlert className="size-4 shrink-0" aria-hidden />
          <span className="font-display flex-1 text-[1.3rem] tracking-[0.03em]">{t("card.stripPending")}</span>
          <span className="text-xs font-semibold">{f.ago(a.createdAt)}</span>
        </div>
      )}
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <Avatar id={a.employee?.id} mood="approval" />
        <div className="min-w-0 flex-1">
          <div className={cn("break-words", pending ? "font-display mb-1 text-[1.6rem] normal-case !leading-[1.08] tracking-[0.005em]" : "text-base font-semibold leading-snug")}>{a.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t.rich("card.wantsToRun", { employee: who, tool: toolLabel, code: (c) => <span className="font-medium text-foreground">{c}</span> })}
            {!pending && <> · {f.ago(a.createdAt)}</>}
            {a.task && (
              <>
                {" "}
                · {t("card.task")}{" "}
                <Link href={`/tasks/${a.task.id}`} className="text-primary">
                  {a.task.title}
                </Link>
              </>
            )}
          </div>
          <div className="mt-1.5 flex items-start gap-1.5 text-xs font-semibold text-destructive">
            <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {reasonText(a.reason)}
          </div>
          {a.olderVersion && (
            <div className="mt-1.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <History className="size-3" aria-hidden /> {t("card.olderVersion")}
              </span>
            </div>
          )}
        </div>
        {!pending && <ApprovalStatusPill status={a.status} />}
      </div>
      <CardContent className="space-y-3 px-5 pb-5">
        {details}
        {outcome}
        {actions && <div className="space-y-2 border-t pt-4">{actions}</div>}
      </CardContent>
    </Card>
  );
}
