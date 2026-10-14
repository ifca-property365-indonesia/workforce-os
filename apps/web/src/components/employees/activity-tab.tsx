"use client";

import Link from "@/lib/nav";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AlertOctagon, AlertTriangle, Bot, Cpu, MessageSquare, MessageSquareShare, Minimize2, ShieldAlert, ShieldCheck, Wrench } from "lucide-react";
import type { StepKind } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { describeReceipt } from "@/lib/step-labels";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface ActivityStep {
  id: string;
  kind: StepKind;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  taskId: string | null;
  taskTitle: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  /** taken inside another employee's run, as a subagent of the code lead */
  asSubagentOf: { id: string; name: string } | null;
  createdAt: string;
}

const KIND_ICON: Record<StepKind, typeof Cpu> = {
  llm: Cpu,
  tool: Wrench,
  guard: ShieldAlert,
  approval: ShieldCheck,
  agent_message: MessageSquareShare,
  compaction: Minimize2,
  budget: AlertTriangle,
  system: Bot,
  error: AlertTriangle,
  incident: AlertOctagon,
};
/** what a person did, not how the model thought: model calls and compactions stay in the task inspector */
const RECEIPT_KINDS: StepKind[] = ["tool", "approval", "agent_message", "guard", "budget", "system", "error", "incident"];
const BAD = ["error", "blocked", "denied", "deny", "stopped"];
const PAGE = 30;

/** Plain-language receipts of what this employee did, newest first, with links to the task or chat. */
export function ActivityTab({ employeeId }: { employeeId: string }) {
  const t = useTranslations("employees");
  const ti = useTranslations("inspector");
  const ta = useTranslations("approvals");
  const f = useFormat();
  const q = useInfiniteQuery({
    queryKey: ["employee-activity", employeeId],
    queryFn: ({ pageParam }) =>
      api.get<{ recent: ActivityStep[]; nextCursor: string | null }>(
        `/api/employees/${employeeId}/activity?kinds=${RECEIPT_KINDS.join(",")}&limit=${PAGE}${pageParam ? `&before=${pageParam}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const toolLabel = (tool: string) => (t.has(`tools.${tool}.label`) ? t(`tools.${tool}.label`) : ta.has(`tools.${tool}`) ? ta(`tools.${tool}`) : tool);
  const steps = q.data?.pages.flatMap((p) => p.recent) ?? [];
  if (q.isLoading) return <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>;
  // the first page failed: say so (an empty list would claim the employee did nothing)
  if (q.isError && !steps.length)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        {t("activity.error")}
        <Button size="sm" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}>
          {t("activity.retry")}
        </Button>
      </div>
    );
  if (!steps.length) return <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>;
  return (
    <div className="space-y-3">
      <ol className="divide-y rounded-lg border">
        {steps.map((s) => {
          const r = describeReceipt(s);
          const values = r.tool ? { ...r.values, tool: toolLabel(r.tool) } : r.values;
          const sentence = t.has(`activity.receipt.${r.key}`) ? t(`activity.receipt.${r.key}`, values) : t("activity.receipt.other", { name: s.name });
          const Icon = KIND_ICON[s.kind] ?? Bot;
          const bad = BAD.includes(s.status);
          return (
            <li key={s.id} className="flex items-start gap-3 px-3 py-2 text-sm">
              <Icon className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", bad && "text-destructive")} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words">{sentence}</span>
                  {s.status !== "ok" && (
                    <span className={cn("rounded px-1.5 text-[11px]", bad ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                      {ti.has(`stepStatus.${s.status}`) ? ti(`stepStatus.${s.status}`) : s.status}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  <time dateTime={s.createdAt} title={f.dateTime(s.createdAt)}>
                    {f.ago(s.createdAt)}
                  </time>
                  {s.asSubagentOf && (
                    <span className="rounded bg-secondary px-1.5 text-[11px] font-medium text-foreground">{t("activity.asSubagent", { name: s.asSubagentOf.name })}</span>
                  )}
                  {s.taskId && (
                    <Link href={`/tasks/${s.taskId}`} className="truncate text-primary hover:underline">
                      {t("activity.inTask", { title: s.taskTitle ?? s.taskId.slice(0, 8) })}
                    </Link>
                  )}
                  {!s.taskId && s.conversationId && (
                    <Link href={`/chat?c=${s.conversationId}`} className="inline-flex items-center gap-1 truncate text-primary hover:underline">
                      <MessageSquare className="size-3" /> {t("activity.inChat", { title: s.conversationTitle ?? "" })}
                    </Link>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {q.isFetchNextPageError && (
        <p role="alert" className="text-sm text-destructive">
          {t("activity.error")}
        </p>
      )}
      {q.hasNextPage && (
        <Button size="sm" variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t("activity.older")}
        </Button>
      )}
    </div>
  );
}
