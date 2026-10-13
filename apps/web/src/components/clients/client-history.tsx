"use client";

import Link from "@/lib/nav";
import { useTranslations } from "next-intl";
import { History, ListTodo, Mail, ReceiptText } from "lucide-react";
import { EmptyState, StatusBadge } from "@/components/layout/common";
import type { ClientDetail } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { InvoiceStatusBadge } from "./shared";

const EMAIL_TONE = { sending: "bg-muted text-muted-foreground", sent: "bg-success/15 text-success", failed: "bg-destructive/15 text-destructive" } as const;

type Entry =
  | { kind: "task"; at: string; item: ClientDetail["history"]["tasks"][number] }
  | { kind: "email"; at: string; item: ClientDetail["history"]["emails"][number] }
  | { kind: "invoice"; at: string; item: ClientDetail["history"]["invoices"][number] };

/** The History tab: tasks, emails and invoices for this client on one timeline, newest first. */
export function ClientHistory({ history }: { history: ClientDetail["history"] }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const entries: Entry[] = [
    ...history.tasks.map((item) => ({ kind: "task" as const, at: item.updatedAt, item })),
    ...history.emails.map((item) => ({ kind: "email" as const, at: item.sentAt ?? item.createdAt, item })),
    ...history.invoices.map((item) => ({ kind: "invoice" as const, at: item.paidAt ?? item.sentAt ?? item.createdAt, item })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!entries.length) return <EmptyState icon={<History className="size-7" />} title={t("history.empty")} />;
  return (
    <ol className="divide-y rounded-lg border bg-card">
      {entries.map((e) => {
        const Icon = e.kind === "task" ? ListTodo : e.kind === "email" ? Mail : ReceiptText;
        return (
          <li key={`${e.kind}-${e.item.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only">{t(`history.kind.${e.kind}`)}</span>
            {e.kind === "task" && (
              <>
                <Link href={`/tasks/${e.item.id}`} className="min-w-0 truncate font-medium hover:underline">
                  {e.item.title}
                </Link>
                <StatusBadge status={e.item.status} />
              </>
            )}
            {e.kind === "email" && (
              <>
                <span className="min-w-0 truncate font-medium">{e.item.subject || t("history.noSubject")}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", EMAIL_TONE[e.item.status])} title={e.item.error ?? undefined}>
                  {t(`history.emailStatus.${e.item.status}`)}
                </span>
                {!!e.item.to.length && <span className="truncate text-xs text-muted-foreground">{e.item.to.join(", ")}</span>}
              </>
            )}
            {e.kind === "invoice" && (
              <>
                <span className="font-mono font-medium">{e.item.number}</span>
                <InvoiceStatusBadge status={e.item.status} />
                <span className="text-xs tabular-nums text-muted-foreground">{f.money(e.item.total, e.item.currency)}</span>
              </>
            )}
            <span className="ml-auto text-xs text-muted-foreground" title={f.dateTime(e.at)}>
              {f.ago(e.at)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
