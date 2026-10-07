import type { TaskStatus } from "@wfos/shared";

export function credits(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v === 0) return "0";
  if (v < 0.01) return v.toFixed(4);
  if (v < 1) return v.toFixed(3);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function usd(n: number | null | undefined): string {
  return `$${(Number(n ?? 0) * 0.01).toFixed(Number(n ?? 0) * 0.01 < 1 ? 4 : 2)}`;
}

export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function dateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  AWAITING_APPROVAL: "Awaiting approval",
  DONE: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const STATUS_TONE: Record<TaskStatus, string> = {
  QUEUED: "bg-secondary text-secondary-foreground",
  RUNNING: "bg-primary/15 text-primary",
  AWAITING_APPROVAL: "bg-warning/20 text-amber-700 dark:text-amber-300",
  DONE: "bg-success/15 text-emerald-700 dark:text-emerald-300",
  FAILED: "bg-destructive/15 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};

export function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}
