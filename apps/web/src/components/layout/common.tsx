"use client";

import type { CSSProperties, ReactNode } from "react";
import type { TaskStatus } from "@wfos/shared";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { STATUS_TONE } from "@/lib/format";
import { signVars, type SignColor } from "@/lib/sign";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-[2.6rem] text-balance">{title}</h1>
        {description && <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const t = useTranslations("status");
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[status], className)}>
      {status === "RUNNING" && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {t(`task.${status}`)}
    </span>
  );
}

/** An employee's avatar on a tile tinted with their sign colour (when known). */
export function Avatar({ emoji, size = "md", color, className }: { emoji?: string | null; size?: "sm" | "md" | "lg"; color?: SignColor; className?: string }) {
  const s = size === "sm" ? "size-7 rounded-lg text-sm" : size === "lg" ? "size-14 rounded-2xl text-3xl" : "size-9 rounded-[10px] text-lg";
  const style: CSSProperties | undefined = color ? { ...signVars(color), background: "color-mix(in srgb, var(--sign) 26%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--sign) 45%, transparent)" } : undefined;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center bg-accent", s, className)} style={style}>
      {emoji || "🤖"}
    </span>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 p-10 text-center">
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
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
        {label}
        {icon}
      </div>
      <div className="font-display mt-2 text-[2.4rem] tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function AutonomyBadge({ level }: { level: string }) {
  const t = useTranslations("status");
  const tone: Record<string, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    QUEUE: "bg-approval/20 text-warning",
    EXECUTE: "bg-[color-mix(in_srgb,var(--sign-biru)_22%,transparent)] text-foreground",
    CLOSE: "bg-[color-mix(in_srgb,var(--sign-ungu)_24%,transparent)] text-foreground",
  };
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tone[level] ?? "bg-muted")}>{t.has(`autonomy.${level}`) ? t(`autonomy.${level}`) : level}</span>;
}
