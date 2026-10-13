"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Download, ReceiptText } from "lucide-react";
import { INVOICE_STATUSES, type InvoiceStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/layout/common";
import { api } from "@/lib/api";
import type { Invoice } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { InvoiceStatusBadge, invalidateClient, useClientRights } from "./shared";

/** the hand-made status changes the API allows from each status (see PATCH /api/invoices/[id]) */
function actionsFor(inv: Invoice): { to: InvoiceStatus; key: "markPaid" | "void" | "backToSent" }[] {
  if (inv.status === "sent")
    return [
      { to: "paid", key: "markPaid" },
      { to: "void", key: "void" },
    ];
  if (inv.status === "draft") return [{ to: "void", key: "void" }];
  return inv.sentAt ? [{ to: "sent", key: "backToSent" }] : [];
}

/** The Invoices tab: the ledger for this client, with paid / void by hand and the PDF of each invoice. */
export function InvoiceLedger({ clientId, invoices }: { clientId: string; invoices: Invoice[] }) {
  const t = useTranslations("clients");
  const f = useFormat();
  const qc = useQueryClient();
  const { canEdit } = useClientRights();
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const shown = status ? invoices.filter((i) => i.status === status) : invoices;
  const setTo = useMutation({
    mutationFn: ({ id, to }: { id: string; to: InvoiceStatus }) => api.patch(`/api/invoices/${id}`, { status: to }),
    onSuccess: () => {
      invalidateClient(qc, clientId);
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("invoices.filter")}>
        {(["", ...INVOICE_STATUSES] as const).map((s) => (
          <button
            key={s || "all"}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", status === s ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
          >
            {s ? t(`invoices.status.${s}`) : t("invoices.all")}
            <span className="ml-1 tabular-nums opacity-70">{s ? invoices.filter((i) => i.status === s).length : invoices.length}</span>
          </button>
        ))}
      </div>
      {!shown.length && <EmptyState icon={<ReceiptText className="size-7" />} title={t("invoices.empty")} description={status ? undefined : t("invoices.emptyHelp")} />}
      {!!shown.length && (
        <ul className="divide-y rounded-lg border bg-card">
          {shown.map((inv) => (
            <li key={inv.id} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center", inv.overdue && "bg-destructive/5")}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{inv.number}</span>
                  <InvoiceStatusBadge status={inv.status} overdue={inv.overdue} />
                  {inv.period && <span className="text-xs text-muted-foreground">{t("invoices.period", { period: inv.period })}</span>}
                </div>
                <div className={cn("text-xs text-muted-foreground", inv.overdue && "font-medium text-destructive")}>
                  {inv.dueDate ? t("invoices.due", { date: f.date(inv.dueDate) }) : t("invoices.noDue")}
                  {inv.sentAt && ` · ${t("invoices.sentOn", { date: f.date(inv.sentAt) })}`}
                  {inv.paidAt && ` · ${t("invoices.paidOn", { date: f.date(inv.paidAt) })}`}
                </div>
              </div>
              <div className="text-right sm:w-52">
                <div className="font-display text-xl tabular-nums">{f.money(inv.total, inv.currency)}</div>
                {inv.taxPercent > 0 && <div className="text-[11px] text-muted-foreground">{t("invoices.inclTax", { percent: inv.taxPercent, tax: f.money(inv.tax, inv.currency) })}</div>}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1">
                {canEdit &&
                  actionsFor(inv).map((a) => (
                    <Button
                      key={a.to}
                      size="sm"
                      variant={a.to === "paid" ? "default" : "ghost"}
                      disabled={setTo.isPending}
                      onClick={() => (a.to !== "void" || confirm(t("invoices.confirmVoid", { number: inv.number }))) && setTo.mutate({ id: inv.id, to: a.to })}
                    >
                      {t(`invoices.actions.${a.key}`)}
                    </Button>
                  ))}
                <Button asChild size="icon" variant="ghost">
                  <a href={`/api/invoices/${inv.id}/pdf`} download aria-label={t("invoices.downloadPdf", { number: inv.number })}>
                    <Download className="size-4" />
                  </a>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
