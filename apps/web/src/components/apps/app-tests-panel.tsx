"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, FlaskConical, Play, TriangleAlert } from "lucide-react";
import Link, { useSearchParams } from "@/lib/nav";
import type { AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NewTaskDialog, type NewTaskPrefill } from "@/components/tasks/new-task-dialog";
import { api } from "@/lib/api";
import { useEmployees } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface Finding {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  role: string | null;
  path: string | null;
  steps: string;
  expected: string;
  actual: string;
}
interface AppTest {
  id: string;
  status: "running" | "passed" | "findings" | "error";
  commit: string | null;
  focus: string;
  roles: string[];
  summary: string | null;
  findings: Finding[];
  handledAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  task: { id: string; status: string | null; tester: string | null } | null;
}

/** testers first: roles that test (QA, tester, penguji) */
const TESTER_RE = /\b(qa|quality|test|tester|penguji|uji)\b/i;
const SEVERITY_TONE: Record<Finding["severity"], string> = { high: "bg-destructive/15 text-destructive", medium: "bg-warning/20 text-foreground", low: "bg-secondary text-muted-foreground" };

/** "#3" in a finding's text → a link to that screenshot of the test */
function withShots(text: string, appId: string, testId: string) {
  return text.split(/(#\d{1,4})\b/).map((part, i) =>
    /^#\d+$/.test(part) ? (
      <a key={i} href={`/api/apps/${appId}/tests/${testId}/screenshots/${part.slice(1)}`} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * C3: browser tests of the preview. A person starts one (a task for a tester employee who drives the preview's
 * browser), the result lists findings with steps and screenshots; a finding becomes a fix task with one click.
 */
export function AppTestsPanel({ app, running, canRun }: { app: Pick<AppDTO, "id" | "name" | "clientId" | "projectId">; running: boolean; canRun: boolean }) {
  const t = useTranslations("apps.tests");
  const f = useFormat();
  const qc = useQueryClient();
  const focusTest = useSearchParams().get("test");
  const key = ["app", app.id, "tests"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ tests: AppTest[] }>(`/api/apps/${app.id}/tests`), refetchInterval: (q) => (q.state.data?.tests.some((x) => x.status === "running") ? 10_000 : false) });
  const { data: accounts } = useQuery({ queryKey: ["app", app.id, "test-users"], queryFn: () => api.get<{ users: { role: string; label: string }[] }>(`/api/apps/${app.id}/test-users`) });
  const { data: employees } = useEmployees();
  const [starting, setStarting] = useState(false);
  const [form, setForm] = useState({ employeeId: "", focus: "", roles: [] as string[] });
  const [fix, setFix] = useState<{ prefill: NewTaskPrefill; n: number } | null>(null);
  const testers = useMemo(() => [...(employees ?? [])].filter((e) => e.status !== "ARCHIVED").sort((a, b) => Number(TESTER_RE.test(b.role)) - Number(TESTER_RE.test(a.role)) || a.name.localeCompare(b.name)), [employees]);

  useEffect(() => {
    if (focusTest) document.getElementById(`test-${focusTest}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusTest, data]);

  const start = useMutation({
    mutationFn: () => api.post<{ testId: string; taskId: string }>(`/api/apps/${app.id}/tests`, { employeeId: form.employeeId || testers[0]?.id, focus: form.focus, roles: form.roles }),
    onSuccess: () => {
      toast.success(t("started"));
      setStarting(false);
      setForm({ employeeId: "", focus: "", roles: [] });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const handled = useMutation({
    mutationFn: (testId: string) => api.post(`/api/apps/${app.id}/tests/${testId}`, { action: "handled" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const fixTask = (test: AppTest, x: Finding) =>
    setFix((cur) => ({
      n: (cur?.n ?? 0) + 1,
      prefill: {
        title: t("fixTitle", { title: x.title }).slice(0, 200),
        brief: [
          t("fixFrom", { app: app.name, commit: test.commit?.slice(0, 8) ?? "?" }),
          x.role ? `${t("finding.role")}: ${x.role}` : "",
          x.path ? `${t("finding.path")}: ${x.path}` : "",
          `${t("finding.steps")}:\n${x.steps}`,
          x.expected ? `${t("finding.expected")}: ${x.expected}` : "",
          `${t("finding.actual")}: ${x.actual}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        ...(app.clientId ? { clientId: app.clientId } : {}),
        ...(app.projectId ? { projectId: app.projectId } : {}),
      },
    }));

  const tests = data?.tests ?? [];
  return (
    <section className="space-y-3" aria-labelledby="app-tests-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="app-tests-title" className="font-display flex-1 text-[1.7rem] leading-none">
          {t("title")}
        </h2>
        {canRun && (
          <Button size="sm" className="gap-1.5" disabled={!running} title={running ? undefined : t("needsPreview")} onClick={() => setStarting(true)}>
            <Play className="size-3.5" aria-hidden /> {t("start")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {!tests.length && <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t("empty")}</p>}
      <ul className="space-y-3">
        {tests.map((x) => (
          <li key={x.id} id={`test-${x.id}`} className={cn("space-y-2 rounded-xl border bg-card p-4", focusTest === x.id && "ring-2 ring-ring")}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {x.status === "passed" ? (
                <CheckCircle2 className="size-4 text-success" aria-hidden />
              ) : x.status === "running" ? (
                <FlaskConical className="size-4 animate-pulse text-muted-foreground" aria-hidden />
              ) : (
                <TriangleAlert className="size-4 text-destructive" aria-hidden />
              )}
              <span className="font-semibold">{t(`status.${x.status}`, { count: x.findings.length })}</span>
              <span className="text-xs text-muted-foreground">
                {[x.task?.tester, x.commit?.slice(0, 8), f.ago(x.finishedAt ?? x.createdAt)].filter(Boolean).join(" · ")}
              </span>
              {x.task && (
                <Link href={`/tasks/${x.task.id}`} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {t("openTask")}
                </Link>
              )}
            </div>
            {x.focus && <p className="text-xs text-muted-foreground">{t("focusWas", { focus: x.focus })}</p>}
            {x.summary && <p className="whitespace-pre-wrap text-sm">{withShots(x.summary, app.id, x.id)}</p>}
            {!!x.findings.length && (
              <ol className="space-y-2">
                {x.findings.map((fd) => (
                  <li key={fd.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded px-1.5 text-[11px] font-bold uppercase", SEVERITY_TONE[fd.severity])}>{t(`severity.${fd.severity}`)}</span>
                      <span className="font-semibold">{fd.title}</span>
                      <span className="text-xs text-muted-foreground">{[fd.role, fd.path].filter(Boolean).join(" · ")}</span>
                    </div>
                    <dl className="mt-1.5 grid gap-1 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-3">
                      <dt className="text-muted-foreground">{t("finding.steps")}</dt>
                      <dd className="whitespace-pre-wrap">{withShots(fd.steps, app.id, x.id)}</dd>
                      {fd.expected && (
                        <>
                          <dt className="text-muted-foreground">{t("finding.expected")}</dt>
                          <dd>{withShots(fd.expected, app.id, x.id)}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">{t("finding.actual")}</dt>
                      <dd>{withShots(fd.actual, app.id, x.id)}</dd>
                    </dl>
                    {canRun && (
                      <Button size="sm" variant="outline" className="mt-2 h-7 px-2 text-xs" onClick={() => fixTask(x, fd)}>
                        {t("makeFixTask")}
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {x.status === "findings" && !x.handledAt && canRun && (
              <Button size="sm" variant="ghost" disabled={handled.isPending} onClick={() => handled.mutate(x.id)}>
                {t("markHandled")}
              </Button>
            )}
            {x.handledAt && <p className="text-xs text-muted-foreground">{t("handledAt", { when: f.ago(x.handledAt) })}</p>}
          </li>
        ))}
      </ul>

      <Dialog open={starting} onOpenChange={setStarting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("startTitle", { app: app.name })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="test-tester">{t("tester")}</Label>
              <select id="test-tester" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.employeeId || testers[0]?.id || ""} onChange={(e) => setForm((v) => ({ ...v, employeeId: e.target.value }))}>
                {testers.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} — {e.role}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="test-focus">{t("focus")}</Label>
              <Textarea id="test-focus" rows={3} value={form.focus} placeholder={t("focusPlaceholder")} onChange={(e) => setForm((v) => ({ ...v, focus: e.target.value }))} />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t("roles")}</legend>
              {!accounts?.users.length && <p className="text-xs text-muted-foreground">{t("noAccounts")}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {accounts?.users.map((u) => (
                  <label key={u.role} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={form.roles.includes(u.role)}
                      onChange={(e) => setForm((v) => ({ ...v, roles: e.target.checked ? [...v.roles, u.role] : v.roles.filter((r) => r !== u.role) }))}
                    />
                    {u.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("rolesHint")}</p>
            </fieldset>
            <p className="text-xs text-muted-foreground">{t("costNote")}</p>
          </div>
          <DialogFooter>
            <Button disabled={start.isPending || !testers.length} onClick={() => start.mutate()}>
              {t("startNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {fix && <NewTaskDialog key={fix.n} open onOpenChange={(o) => !o && setFix(null)} initial={fix.prefill} />}
    </section>
  );
}
