"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UserCog } from "lucide-react";
import Link from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useEmployees } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface Metrics {
  days: number;
  tasks: { done: number; failed: number; cancelled: number; total: number };
  successRate: number | null;
  incidents: { total: number; byKind: Record<string, number> };
  approvals: { requested: number; executed: number; rejected: number; edited: number; expired: number };
  changesRequested: number;
  credits: number;
  activeMinutes: number;
  costliestTasks: { id: string; title: string; credits: number }[];
}
interface Review {
  id: string;
  status: "running" | "done" | "error";
  score: number | null;
  metricScore: number | null;
  summary: string | null;
  strengths: string[];
  issues: string[];
  recommendations: { type: string; text: string }[];
  reviewer: string | null;
  taskId: string | null;
  createdAt: string;
  replay: { id: string; status: string; autoApplied: boolean; judge: { passed: boolean; verdicts: { taskId: string; verdict: string; reason: string }[]; error?: string } | null } | null;
}
const HR_RE = /\b(hr|human|people|sdm|personalia|talent)\b/i;

/**
 * C2: an employee's measured work (exact numbers from the platform's records), its score from them, and HR reviews.
 * An HR review's instruction proposal shows what happened to it: replayed, applied after a passed replay, or waiting
 * for a person (promote / discard, as a person's own replay).
 */
export function HrPanel({ employeeId, admin }: { employeeId: string; admin: boolean }) {
  const t = useTranslations("employees.hr");
  const f = useFormat();
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const key = ["employee-hr", employeeId, days];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ metrics: Metrics; metricScore: number | null; reviews: Review[] }>(`/api/employees/${employeeId}/hr?days=${days}`),
    refetchInterval: (q) => (q.state.data?.reviews.some((r) => r.status === "running" || r.replay?.status === "queued" || r.replay?.status === "running") ? 8000 : false),
  });
  const { data: employees } = useEmployees();
  const reviewers = useMemo(() => [...(employees ?? [])].filter((e) => e.id !== employeeId && e.status !== "ARCHIVED").sort((a, b) => Number(HR_RE.test(b.role)) - Number(HR_RE.test(a.role)) || a.name.localeCompare(b.name)), [employees, employeeId]);
  const [starting, setStarting] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const start = useMutation({
    mutationFn: () => api.post(`/api/employees/${employeeId}/hr`, { reviewerId: reviewerId || reviewers[0]?.id, days }),
    onSuccess: () => {
      toast.success(t("started"));
      setStarting(false);
      void qc.invalidateQueries({ queryKey: ["employee-hr", employeeId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: "promote" | "discard" }) => api.post(`/api/replays/${v.id}`, { action: v.action }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["employee-hr", employeeId] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const m = data?.metrics;
  const tiles: [string, string][] = m
    ? [
        [t("metric.success"), m.successRate === null ? "—" : `${Math.round(m.successRate * 100)}%`],
        [t("metric.tasks"), t("metric.tasksValue", { done: m.tasks.done, failed: m.tasks.failed })],
        [t("metric.incidents"), String(m.incidents.total)],
        [t("metric.approvals"), t("metric.approvalsValue", { rejected: m.approvals.rejected, edited: m.approvals.edited, total: m.approvals.requested })],
        [t("metric.changes"), String(m.changesRequested)],
        [t("metric.credits"), f.credits(m.credits)],
        [t("metric.active"), t("metric.activeValue", { hours: Math.floor(m.activeMinutes / 60), minutes: m.activeMinutes % 60 })],
        [t("metric.score"), data?.metricScore === null || data?.metricScore === undefined ? t("metric.noScore") : `${data.metricScore} / 5`],
      ]
    : [];
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">{t("metricsTitle")}</h2>
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t("period")}>
            {[30, 60, 90].map((d) => (
              <option key={d} value={d}>
                {t("periodDays", { days: d })}
              </option>
            ))}
          </select>
          {admin && (
            <Button size="sm" className="gap-1.5" onClick={() => setStarting(true)}>
              <UserCog className="size-3.5" aria-hidden /> {t("start")}
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map(([k, v]) => (
            <div key={k} className="rounded-lg bg-muted/50 p-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{k}</dt>
              <dd className="font-display text-xl tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {!!m?.costliestTasks.length && (
          <p className="text-xs text-muted-foreground">
            {t("costliest")}{" "}
            {m.costliestTasks.map((c, j) => (
              <span key={c.id}>
                {j > 0 && " · "}
                <Link href={`/tasks/${c.id}`} className="underline underline-offset-2">
                  {c.title}
                </Link>{" "}
                ({f.credits(c.credits)})
              </span>
            ))}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("exactNote")}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("reviewsTitle")}</h2>
        {!data?.reviews.length && <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t("empty")}</p>}
        {data?.reviews.map((r) => (
          <article key={r.id} className="space-y-2 rounded-xl border bg-card p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{r.status === "done" ? t("scoreLine", { score: r.score ?? "—", metric: r.metricScore ?? "—" }) : t(`status.${r.status}`)}</span>
              <span className="text-xs text-muted-foreground">{[r.reviewer, f.ago(r.createdAt)].filter(Boolean).join(" · ")}</span>
              {r.taskId && (
                <Link href={`/tasks/${r.taskId}`} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {t("openTask")}
                </Link>
              )}
            </div>
            {r.summary && <p className="whitespace-pre-wrap">{r.summary}</p>}
            {(r.strengths.length > 0 || r.issues.length > 0) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {r.strengths.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs">
                    <li className="list-none -ml-5 font-semibold text-success">{t("strengths")}</li>
                    {r.strengths.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ul>
                )}
                {r.issues.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs">
                    <li className="list-none -ml-5 font-semibold text-destructive">{t("issues")}</li>
                    {r.issues.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {r.recommendations.length > 0 && (
              <ul className="space-y-0.5 text-xs">
                {r.recommendations.map((x, j) => (
                  <li key={j}>
                    <span className="mr-1.5 rounded bg-secondary px-1.5 font-semibold">{t(`recType.${x.type}`)}</span>
                    {x.text}
                  </li>
                ))}
              </ul>
            )}
            {r.replay && (
              <div className={cn("rounded-lg px-3 py-2 text-xs", r.replay.autoApplied ? "bg-success/10" : r.replay.status === "done" ? "bg-warning/15" : "bg-muted/50")}>
                <p className="font-semibold">
                  {r.replay.autoApplied ? t("proposal.applied") : r.replay.status === "done" ? (r.replay.judge ? t("proposal.waiting") : t("proposal.judging")) : t(`proposal.${r.replay.status === "promoted" ? "promoted" : r.replay.status === "discarded" ? "discarded" : r.replay.status === "failed" ? "failed" : "replaying"}`)}
                </p>
                {r.replay.judge?.verdicts.map((v) => (
                  <p key={v.taskId} className="text-muted-foreground">
                    {t(`verdict.${v.verdict}`)}: {v.reason}
                  </p>
                ))}
                {r.replay.judge?.error && <p className="text-muted-foreground">{r.replay.judge.error}</p>}
                {admin && r.replay.status === "done" && r.replay.judge && (
                  <div className="mt-1.5 flex gap-2">
                    <Button size="sm" className="h-7 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.replay!.id, action: "promote" })}>
                      {t("proposal.promote")}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.replay!.id, action: "discard" })}>
                      {t("proposal.discard")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </article>
        ))}
      </section>

      <Dialog open={starting} onOpenChange={setStarting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("startTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t("startExplain", { days })}</p>
            <Label htmlFor="hr-reviewer">{t("reviewer")}</Label>
            <select id="hr-reviewer" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={reviewerId || reviewers[0]?.id || ""} onChange={(e) => setReviewerId(e.target.value)}>
              {reviewers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button disabled={start.isPending || !reviewers.length} onClick={() => start.mutate()}>
              {t("startNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
