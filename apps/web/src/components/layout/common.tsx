"use client";

import type { ReactNode } from "react";
import type { TaskStatus } from "@wfos/shared";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { STATUS_TONE } from "@/lib/format";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const t = useTranslations("status");
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[status], className)}>
      {status === "RUNNING" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {t(`task.${status}`)}
    </span>
  );
}

export function Avatar({ emoji, size = "md", className }: { emoji?: string | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const s = size === "sm" ? "size-6 text-sm" : size === "lg" ? "size-14 text-3xl" : "size-9 text-lg";
  return <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-accent", s, className)}>{emoji || "🤖"}</span>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-10 text-center">
      {icon && <div className="mb-3 text-muted-foreground">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {icon}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function AutonomyBadge({ level }: { level: string }) {
  const t = useTranslations("status");
  const tone: Record<string, string> = {
    DRAFT: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    QUEUE: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    EXECUTE: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    CLOSE: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  };
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tone[level] ?? "bg-muted")}>{t.has(`autonomy.${level}`) ? t(`autonomy.${level}`) : level}</span>;
}
