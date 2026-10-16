"use client";

import Link from "@/lib/nav";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { GitBranch } from "lucide-react";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface UnmergedItem {
  taskId: string;
  title: string;
  branch: string;
  head: string;
  pushedAt: string;
  state: "unmerged" | "pending" | "failed";
}

/**
 * Finished work pushed on the app's repository that its default branch does not have yet: a deploy of the default
 * branch would not include it, and the next task starts without it. Hidden when there is none.
 */
export function UnmergedWork({ repositoryId }: { repositoryId: string }) {
  const t = useTranslations("apps.unmerged");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["repo-unmerged", repositoryId],
    queryFn: () => api.get<{ repository: { defaultBranch: string }; work: UnmergedItem[] }>(`/api/repositories/${repositoryId}/unmerged`),
  });
  if (!data?.work.length) return null;
  const base = data.repository.defaultBranch;
  return (
    <section className="rounded-xl border border-warning/40 bg-warning/5" aria-labelledby="unmerged-title">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-warning/30 px-4 py-2.5">
        <h2 id="unmerged-title" className="font-display text-[1.35rem] leading-none">
          {t("title", { base, count: data.work.length })}
        </h2>
        <p className="text-xs text-muted-foreground">{t("hint", { base })}</p>
      </header>
      <ul className="divide-y divide-warning/20">
        {data.work.map((w) => (
          <li key={w.taskId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <Link href={`/tasks/${w.taskId}`} className="min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline">
              {w.title}
            </Link>
            <code className="text-xs text-muted-foreground">{w.head.slice(0, 8)}</code>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                w.state === "failed" ? "bg-destructive/15 text-destructive" : w.state === "pending" ? "bg-muted text-muted-foreground" : "bg-warning/15 text-warning",
              )}
            >
              {t(`state.${w.state}`)}
            </span>
            <time className="text-xs text-muted-foreground" dateTime={w.pushedAt} title={f.dateTime(w.pushedAt)}>
              {f.ago(w.pushedAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
