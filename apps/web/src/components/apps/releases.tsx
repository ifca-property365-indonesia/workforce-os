"use client";

import Link from "@/lib/nav";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Copy, History, ScrollText, Undo2 } from "lucide-react";
import { RELEASE_STEPS, type ReleaseDTO, type ReleaseStep } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/layout/common";
import { api } from "@/lib/api";
import type { ReleaseOrigin } from "@/lib/app-previews";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { CommitChip, copyText, isActiveRelease, ReleaseStatusBadge, releaseQueryKey, shortSha, useDuration } from "./shared";

/** warnings that ask a person to look twice are amber; the rest are informational */
export const LOUD_WARNINGS: ReadonlySet<string> = new Set(["destructive_migration", "new_database", "public_access"]);

export function WarningChips({ warnings }: { warnings: ReleaseDTO["warnings"] }) {
  const t = useTranslations("apps");
  if (!warnings.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {warnings.map((w) => (
        <span
          key={w}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase",
            LOUD_WARNINGS.has(w) ? "bg-warning/20 text-warning" : "bg-muted text-muted-foreground",
          )}
        >
          {LOUD_WARNINGS.has(w) && <AlertTriangle className="size-2.5" aria-hidden />}
          {t(`releases.warning.${w}`)}
        </span>
      ))}
    </span>
  );
}

/**
 * Who a release came from. A release a task asked for (request_preview) reads "<employee> via <task>", with the
 * person who approved it underneath (linked to the approval); any other release names the person who started it.
 */
function ReleaseBy({ release: r, origin }: { release: ReleaseDTO; origin: ReleaseOrigin | undefined }) {
  const t = useTranslations("apps");
  if (!origin) return <>{r.createdByName ?? "—"}</>;
  return (
    <div className="max-w-[15rem] space-y-0.5">
      <div className="line-clamp-2">
        {t.rich("releases.byTask", {
          employee: origin.employeeName ?? t("releases.unknownEmployee"),
          title: origin.taskTitle,
          b: (c) => <span className="font-semibold">{c}</span>,
          task: (c) => (
            <Link href={`/tasks/${origin.taskId}`} className="text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid">
              {c}
            </Link>
          ),
        })}
      </div>
      {r.approvalId && (
        <Link href={`/approvals?focus=${r.approvalId}`} className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {r.createdByName ? t("releases.approvedBy", { name: r.createdByName }) : t("releases.viewApproval")}
        </Link>
      )}
    </div>
  );
}

/**
 * The releases of one app, newest first: what ran, how it got there and how long it took. Members open a log;
 * Admins bring back an earlier version that ran.
 */
export function ReleasesTable({
  releases,
  origins = {},
  currentId,
  logs,
  admin,
  onRollback,
  rollbackPending,
}: {
  releases: ReleaseDTO[];
  origins?: Record<string, ReleaseOrigin>;
  currentId: string | null;
  logs: boolean;
  admin: boolean;
  onRollback: (r: ReleaseDTO) => void;
  rollbackPending: boolean;
}) {
  const t = useTranslations("apps");
  const f = useFormat();
  const duration = useDuration();
  const [open, setOpen] = useState<string | null>(null);
  const opened = releases.find((r) => r.id === open) ?? null;
  // an active release ticks its duration every second
  const [now, setNow] = useState(() => Date.now());
  const active = releases.some(isActiveRelease);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [active]);

  if (!releases.length) return <EmptyState icon={<History className="size-7" />} title={t("releases.empty")} />;
  return (
    <>
      <div className="relative overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] tracking-wide text-muted-foreground uppercase">
              <th scope="col" className="px-3 py-2 font-medium">
                {t("releases.columns.status")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("releases.columns.commit")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("releases.columns.trigger")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("releases.columns.by")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("releases.columns.when")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("releases.columns.duration")}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t("releases.log")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {releases.map((r) => {
              const current = r.id === currentId;
              const canRollback = admin && !current && (r.status === "deployed" || r.status === "superseded") && !!r.commit;
              return (
                <tr key={r.id} className={cn("align-top", current && "bg-success/[0.06]", isActiveRelease(r) && "bg-[color-mix(in_srgb,var(--sign-biru)_7%,transparent)]")}>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col items-start gap-1">
                      <ReleaseStatusBadge status={r.status} />
                      {current && <span className="text-[11px] font-semibold text-success">{t("releases.current")}</span>}
                      {r.step && (isActiveRelease(r) || r.status === "failed" || r.status === "rolled_back") && (
                        <span className="text-[11px] text-muted-foreground">{t("releases.atStep", { step: t(`releases.step.${r.step}`) })}</span>
                      )}
                    </div>
                  </td>
                  <td className="max-w-[22rem] px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {r.commit ? <CommitChip sha={r.commit} /> : <span className="text-xs text-muted-foreground">{t("releases.resolving", { branch: r.branch })}</span>}
                      {r.commitSubject && <span className="min-w-0 truncate">{r.commitSubject}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-[11px] text-muted-foreground">{r.branch}</code>
                      <WarningChips warnings={r.warnings} />
                    </div>
                    {r.error && <p className="mt-1 line-clamp-2 text-xs text-destructive">{r.error}</p>}
                  </td>
                  <td className="px-3 py-2.5 text-xs whitespace-nowrap">{t(`releases.trigger.${r.trigger}`)}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <ReleaseBy release={r} origin={r.taskId ? origins[r.taskId] : undefined} />
                  </td>
                  <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                    <time dateTime={r.createdAt} title={f.dateTime(r.createdAt)}>
                      {f.ago(r.createdAt)}
                    </time>
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap tabular-nums">{duration(r, now) ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {logs && (
                        <Button type="button" size="sm" variant={isActiveRelease(r) ? "default" : "ghost"} className="h-8 gap-1" onClick={() => setOpen(r.id)}>
                          <ScrollText className="size-3.5" aria-hidden /> {t("releases.log")}
                        </Button>
                      )}
                      {canRollback && (
                        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1" disabled={rollbackPending} onClick={() => onRollback(r)}>
                          <Undo2 className="size-3.5" aria-hidden /> {t("actions.rollback")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!logs && <p className="text-xs text-muted-foreground">{t("releases.noLogs")}</p>}
      <Sheet open={!!opened} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-3xl">{opened && <LogViewer key={opened.id} release={opened} />}</SheetContent>
      </Sheet>
    </>
  );
}

/** the deploy's steps as a strip: done, the one it is on (or failed at), still to come */
function StepStrip({ release }: { release: ReleaseDTO }) {
  const t = useTranslations("apps");
  const at = release.step ? RELEASE_STEPS.indexOf(release.step) : -1;
  const finished = !isActiveRelease(release);
  const failed = release.status === "failed" || release.status === "rolled_back";
  const allDone = finished && !failed && release.status !== "queued";
  const state = (i: number): "done" | "now" | "fail" | "todo" => {
    if (allDone) return "done";
    if (i < at) return "done";
    if (i === at) return failed ? "fail" : finished ? "done" : "now";
    return "todo";
  };
  return (
    <ol className="flex flex-wrap gap-1" aria-label={t("releases.columns.status")}>
      {RELEASE_STEPS.map((s: ReleaseStep, i) => {
        const st = state(i);
        return (
          <li
            key={s}
            aria-current={st === "now" ? "step" : undefined}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
              st === "done" && "bg-success/15 text-success",
              st === "now" && "animate-pulse bg-[var(--sign-biru)] text-white",
              st === "fail" && "bg-destructive text-white",
              st === "todo" && "bg-muted text-muted-foreground/70",
            )}
          >
            {t(`releases.step.${s}`)}
          </li>
        );
      })}
    </ol>
  );
}

/** A release's log, polled every 2 s while it is queued or deploying, scrolled to the end as lines arrive. */
function LogViewer({ release: initial }: { release: ReleaseDTO }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const f = useFormat();
  const q = useQuery({
    queryKey: releaseQueryKey(initial.id),
    queryFn: () => api.get<{ release: ReleaseDTO; log: string }>(`/api/releases/${initial.id}`),
    refetchInterval: (qq) => (isActiveRelease(qq.state.data?.release ?? initial) ? 2000 : false),
  });
  const release = q.data?.release ?? initial;
  const log = q.data?.log ?? "";
  const live = isActiveRelease(release);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
          {t("releases.logTitle", { commit: release.commit ? shortSha(release.commit) : release.branch })}
          <ReleaseStatusBadge status={release.status} />
        </SheetTitle>
        <SheetDescription className="truncate">
          {[release.commitSubject, release.branch, f.dateTime(release.createdAt)].filter(Boolean).join(" · ")}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <StepStrip release={release} />
        {release.error && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{release.error}</p>}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <pre
            ref={pre}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            aria-label={t("releases.log")}
            aria-busy={live}
            className="min-h-[16rem] flex-1 overflow-auto rounded-lg bg-[#16131a] p-3 pr-11 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-[#e4dce9] [overflow-wrap:anywhere]"
          >
            {log || (live ? t("releases.logWaiting") : t("releases.logEmpty"))}
          </pre>
          {!!log && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute top-1.5 right-1.5 size-8 text-[#e4dce9] hover:bg-white/10 hover:text-white"
              aria-label={t("releases.copyLog")}
              onClick={() => void copyText(log, tc("copied"), toast)}
            >
              <Copy className="size-3.5" />
            </Button>
          )}
        </div>
        {live && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--sign-biru)]" aria-hidden />
            {t("releases.logLive")}
          </p>
        )}
      </div>
    </>
  );
}
