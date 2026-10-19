"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Blocks, CheckCircle2, FlaskConical, Send, TrendingDown, TrendingUp } from "lucide-react";
import Link from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useTeams } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

type AppProblem = "failed" | "unhealthy" | "down" | "maintenance" | "stopped" | "release_failed" | "cert_expiring";
interface Attention {
  apps: { id: string; name: string; problems: { env: "preview" | "live"; problem: AppProblem }[] }[];
  modules: { prdDrafts: number; waiting: number; building: number };
  findings: number;
  spend: { last7: number; prev7: number };
}

/** The home page's "needs attention": apps that are not well, module work and test findings waiting, this week's spend. */
export function AttentionCard() {
  const t = useTranslations("dashboard.attention");
  const f = useFormat();
  const { data } = useQuery({ queryKey: ["dashboard", "attention"], queryFn: () => api.get<Attention>("/api/dashboard/attention"), refetchInterval: 60_000 });
  const lines: { key: string; href: string; tone: "bad" | "warn" | "info"; icon: typeof AlertTriangle; text: string }[] = [];
  for (const a of data?.apps ?? []) {
    const worst = a.problems.some((p) => p.problem === "down" || p.problem === "failed" || (p.env === "live" && p.problem === "release_failed"));
    lines.push({
      key: `app-${a.id}`,
      href: `/apps/${a.id}`,
      tone: worst ? "bad" : "warn",
      icon: AlertTriangle,
      text: `${a.name}: ${a.problems.map((p) => t(`problem.${p.problem}`, { env: t(`env.${p.env}`) })).join(" · ")}`,
    });
  }
  if (data?.modules.prdDrafts) lines.push({ key: "prd", href: "/approvals", tone: "info", icon: Blocks, text: t("prdDrafts", { count: data.modules.prdDrafts }) });
  if (data?.modules.waiting) lines.push({ key: "waiting", href: "/apps", tone: "info", icon: Blocks, text: t("modulesWaiting", { count: data.modules.waiting, building: data.modules.building }) });
  if (data?.findings) lines.push({ key: "findings", href: "/approvals", tone: "warn", icon: FlaskConical, text: t("findings", { count: data.findings }) });
  const delta = data && data.spend.prev7 > 0 ? (data.spend.last7 - data.spend.prev7) / data.spend.prev7 : null;
  return (
    <section aria-labelledby="attention" className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <h2 id="attention" className="font-display text-[1.45rem] tracking-[0.02em]">
          {t("title")}
        </h2>
        {data && (
          <span className="text-right text-xs text-muted-foreground">
            {t("spend", { credits: f.credits(data.spend.last7) })}
            {delta !== null && (
              <span className={cn("ml-1.5 inline-flex items-center gap-0.5 font-semibold", delta > 0.25 ? "text-destructive" : "text-muted-foreground")}>
                {delta >= 0 ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
                {t("vsLastWeek", { pct: Math.round(Math.abs(delta) * 100), sign: delta >= 0 ? "+" : "−" })}
              </span>
            )}
          </span>
        )}
      </div>
      <ul className="divide-y">
        {data && !lines.length && (
          <li className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" aria-hidden /> {t("allGood")}
          </li>
        )}
        {lines.map((l) => (
          <li key={l.key}>
            <Link href={l.href} className="flex items-start gap-2.5 px-5 py-3 text-sm hover:bg-secondary/50">
              <l.icon className={cn("mt-0.5 size-4 shrink-0", l.tone === "bad" ? "text-destructive" : l.tone === "warn" ? "text-warning" : "text-[var(--sign-biru)]")} aria-hidden />
              <span className="min-w-0">{l.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Suggestion {
  id: string;
  name: string;
  matched: string[];
  confident: boolean;
}

/** Debounced "which division is this" for a text (null while it says nothing). */
export function useDivisionSuggestion(text: string, enabled = true): Suggestion | null {
  const [s, setS] = useState<Suggestion | null>(null);
  useEffect(() => {
    if (!enabled || text.trim().length < 6) {
      setS(null);
      return;
    }
    let live = true;
    const h = setTimeout(() => {
      api
        .post<{ suggestion: Suggestion | null }>("/api/tasks/suggest-division", { text })
        .then((r) => live && setS(r.suggestion))
        .catch(() => live && setS(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [text, enabled]);
  return s;
}

/**
 * "What needs doing?": one box on the home page. The division is suggested from the words (shown, changeable) and
 * the task goes to that division's head; the first line becomes the title.
 */
export function QuickCommand() {
  const t = useTranslations("dashboard.command");
  const qc = useQueryClient();
  const { data: divisions } = useTeams();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState("");
  const s = useDivisionSuggestion(text);
  const teamId = picked || (s?.confident ? s.id : "");
  const firstLine = text.trim().split("\n")[0]!.slice(0, 120);
  const send = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/tasks", { title: firstLine, brief: text.trim(), teamId, assigneeId: null, start: true }),
    onSuccess: () => {
      toast.success(t("sent", { division: divisions?.find((d) => d.id === teamId)?.name ?? "" }));
      setText("");
      setPicked("");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <section aria-labelledby="quick-command" className="space-y-3 rounded-2xl border bg-card p-4">
      <h2 id="quick-command" className="font-display text-[1.45rem] tracking-[0.02em]">
        {t("title")}
      </h2>
      <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("placeholder")} aria-label={t("title")} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="sr-only" htmlFor="quick-division">
          {t("division")}
        </label>
        <select id="quick-division" className="h-9 rounded-md border bg-background px-2 text-sm" value={teamId} onChange={(e) => setPicked(e.target.value)}>
          <option value="">{t("chooseDivision")}</option>
          {divisions
            ?.filter((d) => d.leadId)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
        {s && !picked && (
          <span className="text-xs text-muted-foreground">
            {t(s.confident ? "suggested" : "maybe", { name: s.name, words: s.matched.join(", ") })}
          </span>
        )}
        <span className="flex-1" />
        <Button className="gap-1.5" disabled={send.isPending || firstLine.length < 3 || !teamId} onClick={() => send.mutate()}>
          <Send className="size-4" aria-hidden /> {t("send")}
        </Button>
      </div>
    </section>
  );
}
