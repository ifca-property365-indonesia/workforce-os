"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, UserCheck } from "lucide-react";
import type { OutboxStatus } from "@wfos/shared";
import { api } from "@/lib/api";
import type { OutboxItem, OutboxStats } from "@/lib/outbox";
import { cn } from "@/lib/utils";

const TONE: Record<OutboxStatus, string> = {
  pending_approval: "bg-approval text-approval-ink",
  sending: "bg-[var(--sign-biru)]/20 text-foreground",
  sent: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  rejected: "bg-destructive/10 text-destructive",
  expired: "bg-muted text-muted-foreground",
};

export function OutboxStatusBadge({ status, className }: { status: OutboxStatus; className?: string }) {
  const t = useTranslations("outbox");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", TONE[status], className)}>
      {status === "sending" && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {t(`status.${status}`)}
    </span>
  );
}

/** Today's numbers and the policy; the list endpoint carries them, so one cheap call (limit=1) serves the Settings card. */
export function useOutboxStats() {
  return useQuery({
    queryKey: ["outbox", "stats"],
    queryFn: () => api.get<{ stats: OutboxStats }>("/api/outbox?limit=1").then((r) => r.stats),
    refetchInterval: 60_000,
  });
}

/** "a@x.com +2" for a list row */
export function recipientSummary(item: Pick<OutboxItem, "to" | "cc">): { first: string; more: number } {
  const all = [...item.to, ...item.cc];
  return { first: all[0] ?? "", more: Math.max(0, all.length - 1) };
}

export function unknownCount(item: Pick<OutboxItem, "recipients">): number {
  return item.recipients.filter((r) => !r.known).length;
}

/** Every recipient with who they are on the client's file, and the ones that are not on file flagged red. */
export function RecipientList({ item }: { item: Pick<OutboxItem, "to" | "cc" | "recipients" | "client"> }) {
  const t = useTranslations("outbox");
  const cc = new Set(item.cc.map((c) => c.toLowerCase()));
  if (!item.recipients.length) return <p className="text-sm text-muted-foreground">{t("detail.noRecipients")}</p>;
  return (
    <ul className="space-y-1.5">
      {item.recipients.map((r) => (
        <li
          key={r.email}
          className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-2.5 py-1.5 text-sm", !r.known && "border-destructive/40 bg-destructive/5")}
        >
          {r.known ? <UserCheck className="size-3.5 shrink-0 text-success" aria-hidden /> : <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden />}
          <span className="min-w-0 break-all font-medium">{r.email}</span>
          {[...cc].some((c) => c.includes(r.email)) && <span className="rounded bg-muted px-1 text-[10px] font-semibold uppercase text-muted-foreground">{t("detail.cc")}</span>}
          {r.known ? (
            <span className="text-xs text-muted-foreground">
              {[r.contactName, r.role && (t.has(`roles.${r.role}`) ? t(`roles.${r.role}`) : r.role)].filter(Boolean).join(" · ")}
            </span>
          ) : (
            <span className="text-xs font-semibold text-destructive">{item.client ? t("detail.notOnClientFile", { client: item.client.name }) : t("detail.notInMaster")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function formatBytes(n: number, locale: string): string {
  if (n < 1024) return new Intl.NumberFormat(locale, { style: "unit", unit: "byte", unitDisplay: "short" }).format(n);
  if (n < 1024 * 1024) return new Intl.NumberFormat(locale, { style: "unit", unit: "kilobyte", unitDisplay: "short", maximumFractionDigits: 0 }).format(n / 1024);
  return new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1 }).format(n / (1024 * 1024));
}
