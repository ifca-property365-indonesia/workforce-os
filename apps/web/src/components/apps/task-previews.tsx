"use client";

import Link from "@/lib/nav";
import { useTranslations } from "next-intl";
import { ExternalLink, Rocket, ShieldCheck } from "lucide-react";
import { PREVIEW_MAX_FAILED_ATTEMPTS } from "@wfos/shared";
import type { TaskPreview } from "@/lib/app-previews";
import { signVars } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { WarningChips } from "./releases";
import { CommitChip, ReleaseStatusBadge, appColors, isActiveRelease, useApps } from "./shared";

/**
 * The previews a Developer published from this task, newest first: where each deploy is, the address once it is
 * live, and how many tries are left before the task fails instead of going back to the Developer.
 */
export function TaskPreviews({ previews }: { previews: TaskPreview[] }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const { data: apps } = useApps();
  if (!previews.length) return null;
  const colors = appColors((apps ?? []).map((a) => a.id).concat(previews.map((p) => p.appId)));
  const failed = previews.filter((p) => p.status === "failed" || p.status === "rolled_back").length;
  return (
    <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="task-previews-title">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <Rocket className="size-4 text-muted-foreground" aria-hidden />
        <h3 id="task-previews-title" className="font-display flex-1 text-[1.35rem] leading-none">
          {t("taskPreviews.title")}
        </h3>
        {failed > 0 && (
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", failed >= PREVIEW_MAX_FAILED_ATTEMPTS ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning")}>
            {t("taskPreviews.failedAttempts", { count: failed, max: PREVIEW_MAX_FAILED_ATTEMPTS })}
          </span>
        )}
      </header>
      <ol className="divide-y">
        {previews.map((p) => {
          const color = colors.get(p.appId) ?? "biru";
          const active = isActiveRelease(p);
          return (
            <li key={p.id} className="space-y-2 px-4 py-3" style={signVars(color)}>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/apps/${p.appId}`}
                  className={cn("sign font-display rounded px-2 pt-1 pb-0.5 text-[1.05rem] leading-none", active && "animate-pulse")}
                  data-state={p.status === "deployed" || active ? "lit" : "off"}
                >
                  {p.appName}
                </Link>
                <ReleaseStatusBadge status={p.status} />
                {p.step && (active || p.status === "failed" || p.status === "rolled_back") && (
                  <span className="text-xs text-muted-foreground">{t("releases.atStep", { step: t(`releases.step.${p.step}`) })}</span>
                )}
                <time className="ml-auto text-xs text-muted-foreground" dateTime={p.createdAt} title={f.dateTime(p.createdAt)}>
                  {f.ago(p.createdAt)}
                </time>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                <CommitChip sha={p.commit} />
                {p.commitSubject && <span className="min-w-0 truncate">{p.commitSubject}</span>}
                <WarningChips warnings={p.warnings} />
              </div>
              {p.url && (
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-2 rounded-lg border-2 border-dashed border-[var(--sign)]/60 px-3 py-1 font-mono text-xs font-semibold transition-colors hover:border-[var(--sign)]"
                >
                  <span className="min-w-0 truncate">{p.url.replace(/^https:\/\//, "")}</span>
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                  <span className="sr-only">{t("detail.open")}</span>
                </a>
              )}
              {active && <p className="text-xs text-muted-foreground">{t("taskPreviews.waiting")}</p>}
              {p.error && <p className="line-clamp-3 text-xs text-destructive">{p.error}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <Link href={`/apps/${p.appId}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {t("taskPreviews.openApp")}
                </Link>
                {p.approvalId && (
                  <Link href={`/approvals?focus=${p.approvalId}`} className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                    <ShieldCheck className="size-3" aria-hidden /> {t("taskPreviews.approval")}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
