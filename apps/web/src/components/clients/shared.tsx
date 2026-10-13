"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ClientStatus, InvoiceStatus } from "@wfos/shared";
import { cn } from "@/lib/utils";
import { useMe, type ClientProject } from "@/lib/hooks";

export const HEALTH_TONE: Record<ClientProject["health"], string> = {
  late: "bg-destructive/15 text-destructive",
  at_risk: "bg-warning/20 text-warning",
  on_track: "bg-success/15 text-success",
  done: "bg-muted text-muted-foreground",
};

const CLIENT_TONE: Record<ClientStatus, string> = {
  active: "bg-success/15 text-success",
  prospect: "bg-[color-mix(in_srgb,var(--sign-biru)_20%,transparent)] text-foreground",
  inactive: "bg-muted text-muted-foreground",
};

const INVOICE_TONE: Record<InvoiceStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-approval/20 text-warning",
  paid: "bg-success/15 text-success",
  void: "bg-muted text-muted-foreground line-through",
};

// font-sans/normal-case: a pill inside a big sign-painter number keeps its own lettering
const pill = "inline-flex items-center rounded-full px-2 py-0.5 font-sans text-[11px] font-medium normal-case tracking-normal whitespace-nowrap";

export function ClientStatusBadge({ status, className }: { status: ClientStatus; className?: string }) {
  const t = useTranslations("clients");
  return <span className={cn(pill, CLIENT_TONE[status], className)}>{t(`status.${status}`)}</span>;
}

export function InvoiceStatusBadge({ status, overdue }: { status: InvoiceStatus; overdue?: boolean }) {
  const t = useTranslations("clients");
  if (overdue) return <span className={cn(pill, "bg-destructive/15 text-destructive")}>{t("invoices.overdue")}</span>;
  return <span className={cn(pill, INVOICE_TONE[status])}>{t(`invoices.status.${status}`)}</span>;
}

export function HealthBadge({ health, title }: { health: ClientProject["health"]; title?: string }) {
  const t = useTranslations("clients");
  return (
    <span className={cn(pill, HEALTH_TONE[health])} title={title}>
      {t(`health.${health}`)}
    </span>
  );
}

const HEALTH_RANK: ClientProject["health"][] = ["late", "at_risk", "on_track", "done"];
/** the most worrying health among a client's projects (null without projects) */
export function worstHealth(projects: Pick<ClientProject, "health">[]): ClientProject["health"] | null {
  return HEALTH_RANK.find((h) => projects.some((p) => p.health === h)) ?? null;
}

/** what the signed-in person may do on client pages: MEMBER+ edits clients and invoices, ADMIN+ billing and deletes */
export function useClientRights() {
  const { data: me } = useMe();
  const role = me?.role;
  return { canEdit: !!role && role !== "VIEWER", admin: role === "OWNER" || role === "ADMIN" };
}

/** after a change to one client: its page and the list (totals, health) */
export function invalidateClient(qc: QueryClient, id: string) {
  void qc.invalidateQueries({ queryKey: ["client", id] });
  void qc.invalidateQueries({ queryKey: ["clients"] });
}

export const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";
