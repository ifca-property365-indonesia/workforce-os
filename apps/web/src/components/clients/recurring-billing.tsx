"use client";

import { useId, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import { BILLING_PERIODS, type BillingPeriod } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useCompanyProfile, useEmployees, type ClientProject, type RecurringBilling } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { invalidateClient, selectClass, useClientRights } from "./shared";

type Form = {
  description: string;
  amount: string;
  taxPercent: string;
  dueDays: string;
  period: BillingPeriod;
  dayOfMonth: number;
  startMonth: number;
  projectId: string;
  employeeId: string;
  recipients: string;
  active: boolean;
};

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function useMonthName() {
  const f = useFormat();
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(f.locale, { month: "long", timeZone: "UTC" });
    return (m: number) => fmt.format(new Date(Date.UTC(2000, m - 1, 1)));
  }, [f.locale]);
}

function BillingDialog({ clientId, currency, projects, row, onClose }: { clientId: string; currency: string; projects: ClientProject[]; row?: RecurringBilling; onClose: () => void }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const monthName = useMonthName();
  const { data: emps } = useEmployees();
  const { data: company } = useCompanyProfile();
  const active = (emps ?? []).filter((e) => e.status !== "ARCHIVED");
  // Finance employees first: the approval shows them as the one asking to send the invoice
  const finance = active.filter((e) => e.department === "finance");
  const others = active.filter((e) => e.department !== "finance");
  const [f, setF] = useState<Form>(() =>
    row
      ? {
          description: row.description,
          amount: String(row.amount),
          taxPercent: String(row.taxPercent),
          dueDays: String(row.dueDays),
          period: row.period,
          dayOfMonth: row.dayOfMonth,
          startMonth: row.startMonth ?? 1,
          projectId: row.projectId ?? "",
          employeeId: row.employeeId ?? "",
          recipients: row.recipients.join(", "),
          active: row.active,
        }
      : { description: "", amount: "", taxPercent: "", dueDays: "14", period: "monthly", dayOfMonth: 1, startMonth: new Date().getMonth() + 1, projectId: "", employeeId: "", recipients: "", active: true },
  );
  // until the person picks, a new billing takes the company's default tax and the first Finance employee
  const taxPercent = f.taxPercent === "" && !row ? String(company?.defaultTaxPercent ?? 0) : f.taxPercent;
  const employeeId = f.employeeId === "" && !row ? (finance[0]?.id ?? "") : f.employeeId;
  const save = useMutation({
    mutationFn: () => {
      const body = {
        clientId,
        description: f.description.trim(),
        amount: Number(f.amount),
        taxPercent: Number(taxPercent) || 0,
        dueDays: Number(f.dueDays) || 0,
        period: f.period,
        dayOfMonth: f.dayOfMonth,
        startMonth: f.period === "yearly" ? f.startMonth : null,
        projectId: f.projectId || null,
        employeeId: employeeId === "-" ? null : employeeId || null,
        recipients: f.recipients
          .split(/[,;\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        active: f.active,
      };
      return row ? api.patch(`/api/recurring-billings/${row.id}`, body) : api.post("/api/recurring-billings", body);
    },
    onSuccess: () => (toast.success(tc("saved")), invalidateClient(qc, clientId), onClose()),
    onError: (e) => toast.error((e as Error).message),
  });
  const valid = f.description.trim() && Number(f.amount) > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? t("recurring.edit") : t("recurring.add")}</DialogTitle>
          <DialogDescription>{t("recurring.dialogHelp")}</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[65vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-description`}>{t("recurring.description")}</Label>
            <Input id={`${uid}-description`} value={f.description} placeholder={t("recurring.descriptionPlaceholder")} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-amount`}>{t("recurring.amount", { currency })}</Label>
            <Input id={`${uid}-amount`} type="number" min={0} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-tax`}>{t("recurring.taxPercent")}</Label>
              <Input id={`${uid}-tax`} type="number" min={0} max={100} value={taxPercent} onChange={(e) => setF({ ...f, taxPercent: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-due`}>{t("recurring.dueDays")}</Label>
              <Input id={`${uid}-due`} type="number" min={0} max={120} value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-period`}>{t("recurring.period")}</Label>
            <select id={`${uid}-period`} className={selectClass} value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as BillingPeriod })}>
              {BILLING_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`recurring.periods.${p}`)}
                </option>
              ))}
            </select>
          </div>
          <div className={cn("grid gap-3", f.period === "yearly" && "grid-cols-2")}>
            {f.period === "yearly" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-month`}>{t("recurring.month")}</Label>
                <select id={`${uid}-month`} className={selectClass} value={f.startMonth} onChange={(e) => setF({ ...f, startMonth: Number(e.target.value) })}>
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {monthName(m)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-day`}>{t("recurring.day")}</Label>
              <select id={`${uid}-day`} className={selectClass} value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: Number(e.target.value) })}>
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-project`}>{t("recurring.project")}</Label>
            <select id={`${uid}-project`} className={selectClass} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              <option value="">—</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-employee`}>{t("recurring.employee")}</Label>
            <select id={`${uid}-employee`} className={selectClass} value={employeeId || "-"} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
              <option value="-">{t("recurring.noEmployee")}</option>
              {!!finance.length && (
                <optgroup label={t("recurring.finance")}>
                  {finance.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} — {e.role}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t("recurring.otherEmployees")}>
                {others.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} — {e.role}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-recipients`}>{t("recurring.recipients")}</Label>
            <Input id={`${uid}-recipients`} value={f.recipients} placeholder={t("recurring.recipientsPlaceholder")} onChange={(e) => setF({ ...f, recipients: e.target.value })} />
            <p className="text-xs text-muted-foreground">{t("recurring.recipientsHelp")}</p>
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch id={`${uid}-active`} checked={f.active} onCheckedChange={(v) => setF({ ...f, active: v })} />
            <Label htmlFor={`${uid}-active`}>{t("recurring.active")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? tc("saving") : tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Recurring billing tab: on its day each billing drafts an invoice and asks a person to approve sending it. */
export function RecurringBillings({ clientId, currency, rows, projects }: { clientId: string; currency: string; rows: RecurringBilling[]; projects: ClientProject[] }) {
  const t = useTranslations("clients");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const monthName = useMonthName();
  const { admin } = useClientRights();
  const { data: emps } = useEmployees();
  const [edit, setEdit] = useState<{ row?: RecurringBilling } | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/recurring-billings/${id}`),
    onSuccess: () => invalidateClient(qc, clientId),
    onError: (e) => toast.error((e as Error).message),
  });
  const toggle = useMutation({
    mutationFn: (r: RecurringBilling) => api.patch(`/api/recurring-billings/${r.id}`, { active: !r.active }),
    onSuccess: () => invalidateClient(qc, clientId),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("recurring.help")}</p>
      {!rows.length && <EmptyState icon={<CalendarClock className="size-7" />} title={t("recurring.empty")} />}
      {rows.map((r) => {
        const emp = emps?.find((e) => e.id === r.employeeId);
        const project = projects.find((p) => p.id === r.projectId);
        return (
          <div key={r.id} className={cn("flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-start", !r.active && "opacity-70")}>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.description}</span>
                {!r.active && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("recurring.paused")}</span>}
              </div>
              <div className="font-display text-2xl tabular-nums">
                {f.money(r.amount, currency)}
                <span className="ml-1.5 font-sans text-xs font-normal normal-case tracking-normal text-muted-foreground">
                  {r.period === "yearly" ? t("recurring.perYear") : t("recurring.perMonth")}
                  {r.taxPercent > 0 && ` · ${t("recurring.plusTax", { percent: r.taxPercent })}`}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {r.period === "yearly" ? t("recurring.scheduleYearly", { day: r.dayOfMonth, month: monthName(r.startMonth ?? 1) }) : t("recurring.scheduleMonthly", { day: r.dayOfMonth })}
                {" · "}
                {t("recurring.dueAfter", { count: r.dueDays })}
                {project && ` · ${project.name}`}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("recurring.requester", { name: emp?.name ?? t("recurring.noEmployee") })}
                {" · "}
                {r.recipients.length ? t("recurring.sendTo", { to: r.recipients.join(", ") }) : t("recurring.sendToContacts")}
              </div>
              {r.active && r.nextRunAt && <div className="text-xs font-medium">{t("recurring.nextRun", { when: f.dateTime(r.nextRunAt) })}</div>}
            </div>
            {admin && (
              <div className="flex items-center gap-1">
                <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} aria-label={t("recurring.active")} />
                <Button size="icon" variant="ghost" onClick={() => setEdit({ row: r })} aria-label={tc("edit")}>
                  <Pencil className="size-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => confirm(t("recurring.confirmDelete", { name: r.description })) && del.mutate(r.id)} aria-label={tc("delete")}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {admin && (
        <Button variant="outline" size="sm" className="gap-1" onClick={() => setEdit({})}>
          <Plus className="size-3.5" /> {t("recurring.add")}
        </Button>
      )}
      {edit && <BillingDialog clientId={clientId} currency={currency} projects={projects} row={edit.row} onClose={() => setEdit(null)} />}
    </div>
  );
}
