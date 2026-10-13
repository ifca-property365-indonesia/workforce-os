"use client";

import Link from "@/lib/nav";
import { useTranslations } from "next-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Building2, FileText, KanbanSquare, Paperclip, RotateCcw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/layout/common";
import { ApprovalCard } from "@/components/approvals";
import { usePendingApprovals } from "@/components/approvals/pending-list";
import { api } from "@/lib/api";
import type { OutboxItem } from "@/lib/outbox";
import { useFormat } from "@/lib/use-format";
import { formatBytes, OutboxStatusBadge, RecipientList, unknownCount } from "./parts";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A pending proposal is decided right here, with the same card (and endpoints) as the approvals inbox. */
function PendingDecision({ approvalId, admin }: { approvalId: string; admin: boolean }) {
  const t = useTranslations("outbox");
  const { data, isLoading } = usePendingApprovals();
  const a = data?.find((x) => x.id === approvalId);
  if (isLoading) return null;
  if (!a)
    return (
      <Link href={`/approvals?focus=${approvalId}`} className="text-sm text-primary underline-offset-2 hover:underline">
        {t("detail.openInApprovals")}
      </Link>
    );
  return <ApprovalCard a={a} readOnly={!admin} />;
}

/** Everything about one outbox line: who sent what to whom, whether the recipients are on file, and what to do next. */
export function OutboxDetail({ item, admin }: { item: OutboxItem; admin: boolean }) {
  const t = useTranslations("outbox");
  const f = useFormat();
  const qc = useQueryClient();
  const resend = useMutation({
    mutationFn: () => api.post(`/api/outbox/${item.id}/resend`),
    onSuccess: () => {
      toast.success(t("detail.resendQueued"));
      void qc.invalidateQueries({ queryKey: ["outbox"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const unknown = unknownCount(item);
  const pending = item.status === "pending_approval" && !!item.approvalId;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <OutboxStatusBadge status={item.status} />
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold uppercase text-muted-foreground">{t(`kind.${item.kind}`)}</span>
          {item.trigger && <span className="text-xs text-muted-foreground">{t(`trigger.${item.trigger}`)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {item.employee && (
            <span className="inline-flex items-center gap-1">
              <Avatar id={item.employee.id} size="sm" className="size-5 p-0" /> {item.employee.name}
            </span>
          )}
          <span>{t("detail.created", { when: f.dateTime(item.createdAt) })}</span>
          {item.sentAt && <span>{t("detail.sent", { when: f.dateTime(item.sentAt) })}</span>}
          {item.client && (
            <span className="inline-flex items-center gap-1">
              <Building2 className="size-3.5" aria-hidden /> {item.client.name}
            </span>
          )}
          {item.taskId && (
            <Link href={`/tasks/${item.taskId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
              <KanbanSquare className="size-3.5" aria-hidden /> {t("detail.task")}
            </Link>
          )}
        </div>
      </div>

      {item.error && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <div className="font-semibold">{item.status === "rejected" ? t("detail.rejectedBecause") : t("detail.failedBecause")}</div>
            <div className="break-words">{item.error}</div>
          </div>
        </div>
      )}

      {item.status === "failed" && item.resentAs && (
        <Link href={`/outbox?focus=${item.resentAs}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary underline-offset-2 hover:underline">
          <RotateCcw className="size-4" aria-hidden /> {t("detail.resentAs")}
        </Link>
      )}
      {item.resendOf && (
        <Link href={`/outbox?focus=${item.resendOf}`} className="block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {t("detail.resendOf")}
        </Link>
      )}

      {item.status === "failed" && !item.resentAs && (
        <div className="flex flex-wrap items-center gap-2">
          {admin ? (
            <Button onClick={() => resend.mutate()} disabled={resend.isPending} className="gap-1.5">
              <RotateCcw className="size-4" /> {t("detail.resend")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t("detail.resendAdminOnly")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("detail.resendHint")}</p>
        </div>
      )}

      <Section title={t("detail.recipients")}>
        {unknown > 0 && (
          <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <ShieldAlert className="size-3.5" aria-hidden /> {pending ? t("detail.unknownWarning", { count: unknown }) : t("detail.unknownWarningSent", { count: unknown })}
          </p>
        )}
        <RecipientList item={item} />
      </Section>

      {pending ? (
        <Section title={t("detail.decision")}>
          <PendingDecision approvalId={item.approvalId!} admin={admin} />
        </Section>
      ) : (
        <>
          <Section title={t("detail.message")}>
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b px-3 py-2 text-sm font-semibold">{item.subject || t("detail.noSubject")}</div>
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-sans text-sm">{item.body || "—"}</pre>
            </div>
          </Section>
          {item.attachments.length > 0 && (
            <Section title={t("detail.attachments")}>
              <ul className="space-y-1">
                {item.attachments.map((a) => (
                  <li key={a.filename} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                    {a.filename.toLowerCase().endsWith(".pdf") ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                    {a.size > 0 && <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(a.size, f.locale)}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
