"use client";

import Link from "next/link";
import { memo } from "react";
import { useTranslations } from "next-intl";
import { Check, KanbanSquare, Loader2 } from "lucide-react";
import { MAX_RESPONDERS_PER_TURN, type ChatMessageDTO, type RoutedBy } from "@wfos/shared";
import { ApprovalCard } from "@/components/approvals";
import { Avatar } from "@/components/layout/common";
import type { Employee } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

/** The worker's per-turn responder cap (apps/worker MAX_RESPONDERS_PER_TURN); members beyond it are not asked. */

const FALLBACK_REASONS = ["timeout", "error", "low_confidence", "invalid", "lead_unavailable", "killswitch", "demo", "budget"];

/** How a team-chat responder was picked; nothing for the default (lead / everyone) modes. */
export function RoutedByBadge({ routedBy }: { routedBy: RoutedBy }) {
  const t = useTranslations("chat");
  let text: string | null = null;
  if (routedBy.mode === "auto") {
    text = typeof routedBy.confidence === "number" ? t("routed.auto", { confidence: Math.round(routedBy.confidence * 100) }) : t("routed.autoNoScore");
  } else if (routedBy.mode === "mention") {
    text = t("routed.mention");
  } else if (routedBy.mode === "fallback") {
    const reason = routedBy.reason && FALLBACK_REASONS.includes(routedBy.reason) ? routedBy.reason : "other";
    text = t("routed.fallback", { reason: t(`routed.reasons.${reason}`) });
  }
  if (!text) return null;
  return <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", routedBy.mode === "fallback" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground")}>{text}</span>;
}

/** "N teammates not asked (limit 5 per message)" under the turn's last reply, with their names on hover. */
function SkippedNote({ ids, names }: { ids: readonly string[]; names: (id: string) => string | undefined }) {
  const t = useTranslations("chat");
  if (!ids.length) return null;
  const who = ids.map(names).filter((n): n is string => !!n);
  return (
    <div className="text-[11px] text-muted-foreground" title={who.length ? who.join(", ") : undefined}>
      {t("hints.skippedResponders", { count: ids.length, limit: MAX_RESPONDERS_PER_TURN })}
    </div>
  );
}

/** A system receipt (an approval decided, a busy responder, nobody to answer…), centred and quiet, whoever wrote it. */
function Receipt({ m, author, highlighted, names }: { m: ChatMessageDTO; author: Employee | undefined; highlighted: boolean; names: (id: string) => string | undefined }) {
  const t = useTranslations("chat");
  const fmt = useFormat();
  let text = m.content;
  if (m.meta?.hint === "no_responder") text = t("hints.noResponder");
  else if (m.meta?.hint === "busy") text = author ? t("hints.busy", { name: author.name }) : t("hints.busyUnknown");
  return (
    <div id={`msg-${m.id}`} className="flex flex-col items-center gap-0.5">
      <div className={cn("max-w-[85%] rounded-full bg-muted/60 px-3 py-1 text-center text-xs text-muted-foreground transition-shadow", highlighted && "ring-2 ring-primary")}>
        {text} <span className="text-[10px] opacity-70">· {fmt.ago(m.createdAt)}</span>
      </div>
      <SkippedNote ids={m.meta?.skippedResponders ?? []} names={names} />
    </div>
  );
}

/**
 * One chat message. Memoised: while a reply streams only that row re-renders. Callers keep the props stable
 * (`m` objects are replaced only when that message changes, `author` comes from the query cache, `onMakeTask`
 * and `names` are stable callbacks).
 */
export const MessageItem = memo(function MessageItem({
  m,
  author,
  fallbackAvatar,
  teamChat,
  canDecide,
  highlighted,
  onMakeTask,
  names,
}: {
  m: ChatMessageDTO;
  author: Employee | undefined;
  fallbackAvatar: string | undefined;
  teamChat: boolean;
  canDecide: boolean;
  highlighted: boolean;
  onMakeTask: (text: string) => void;
  /** employee id → name, for the "not asked" note */
  names: (id: string) => string | undefined;
}) {
  const t = useTranslations("chat");
  const fmt = useFormat();
  if (m.role === "system") return <Receipt m={m} author={author} highlighted={highlighted} names={names} />;
  const mine = m.role === "user";
  const chips = !mine ? (m.meta?.chips ?? []) : [];
  const approvals = !mine ? (m.approvals ?? []) : [];
  return (
    <div id={`msg-${m.id}`} className={cn("flex gap-2", mine && "flex-row-reverse")}>
      {!mine && <Avatar emoji={author?.avatar ?? fallbackAvatar} size="sm" className="mt-1" />}
      <div className={cn("max-w-[85%] space-y-1", mine && "items-end text-right")}>
        {!mine && teamChat && (author || m.meta?.routedBy) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {author && <span className="font-medium text-foreground">{author.name}</span>}
            {author && <span className="text-muted-foreground">{author.role}</span>}
            {m.meta?.routedBy && <RoutedByBadge routedBy={m.meta.routedBy} />}
          </div>
        )}
        <div
          className={cn(
            "inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-sm transition-shadow",
            mine ? "bg-primary text-primary-foreground" : "bg-muted",
            highlighted && "ring-2 ring-primary ring-offset-2 ring-offset-card",
          )}
        >
          {m.content || (
            <span role="status" className="inline-flex">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              <span className="sr-only">{author ? t("replyingAs", { name: author.name }) : t("replying")}</span>
            </span>
          )}
        </div>
        {!!m.attachments?.length && (
          <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
            {m.attachments.map((a) => (
              <span key={a.name} className="rounded border px-1.5 py-0.5">
                📎 {a.name}
              </span>
            ))}
          </div>
        )}
        {!!chips.length && (
          <div className="flex flex-wrap gap-1">
            {chips.map((c, i) => (
              <span key={`${c.tool}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
                <Check className="size-3" />
                {t("chip", { label: c.label })}
              </span>
            ))}
          </div>
        )}
        {!!approvals.length && (
          <div className="w-[min(32rem,100%)] space-y-2 pt-1">
            {approvals.map((a) => (
              <ApprovalCard key={a.id} a={a} compact readOnly={!canDecide} />
            ))}
          </div>
        )}
        {!mine && <SkippedNote ids={m.meta?.skippedResponders ?? []} names={names} />}
        <div className={cn("flex items-center gap-2 text-[11px] text-muted-foreground", mine && "justify-end")}>
          {fmt.ago(m.createdAt)}
          {m.taskId && (
            <Link href={`/tasks/${m.taskId}`} className="text-primary hover:underline">
              {t("taskCreatedLink")}
            </Link>
          )}
          {!mine && m.content && (
            <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => onMakeTask(m.content)}>
              <KanbanSquare className="size-3" /> {t("createTask")}
            </button>
          )}
          {mine && (
            <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => onMakeTask(m.content)}>
              <KanbanSquare className="size-3" /> {t("makeTask")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
