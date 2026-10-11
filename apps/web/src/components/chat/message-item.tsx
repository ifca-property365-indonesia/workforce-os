"use client";

import Link from "next/link";
import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronLeft, ChevronRight, KanbanSquare, Loader2, Paperclip, Pencil, RefreshCw } from "lucide-react";
import { MAX_RESPONDERS_PER_TURN, type ChatMessageDTO, type RoutedBy } from "@wfos/shared";
import { ApprovalCard } from "@/components/approvals";
import { Avatar } from "@/components/layout/common";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Employee } from "@/lib/hooks";
import type { SignColor } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

/** The worker's per-turn responder cap (apps/worker MAX_RESPONDERS_PER_TURN); members beyond it are not asked. */

/** shown while the row is hovered or anything in it has keyboard focus; always reachable with Tab */
const hoverAction =
  "inline-flex items-center gap-0.5 rounded opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100";

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
  return <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", routedBy.mode === "fallback" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>{text}</span>;
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
      <div className={cn("max-w-[85%] rounded-full border bg-card px-3 py-1 text-center text-xs text-muted-foreground transition-shadow", highlighted && "ring-2 ring-ring")}>
        {text} <span className="text-[10px] opacity-70">· {fmt.ago(m.createdAt)}</span>
      </div>
      <SkippedNote ids={m.meta?.skippedResponders ?? []} names={names} />
    </div>
  );
}

/**
 * "‹ 2/3 ›": step through the versions of a message (edits of a user message, regenerated replies). The chat
 * moves focus to the same control on the version switched to (that row is a different message), and announces
 * "Version 2 of 3" in a live region.
 */
function VersionSwitcher({
  branch,
  disabled,
  onSwitch,
}: {
  branch: NonNullable<ChatMessageDTO["branch"]>;
  disabled: boolean;
  onSwitch: (messageId: string, dir: "prev" | "next") => void;
}) {
  const t = useTranslations("chat");
  const prev = branch.siblingIds[branch.index - 1];
  const next = branch.siblingIds[branch.index + 1];
  const btn = "inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";
  return (
    <span
      role="group"
      data-version-switcher=""
      tabIndex={-1}
      aria-label={t("versions.label", { index: branch.index + 1, count: branch.count })}
      className="inline-flex items-center gap-0.5 tabular-nums focus-visible:outline-none"
    >
      <button type="button" className={btn} disabled={disabled || !prev} onClick={() => prev && onSwitch(prev, "prev")} aria-label={t("versions.previous")} title={t("versions.previous")}>
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span aria-hidden>{t("versions.position", { index: branch.index + 1, count: branch.count })}</span>
      <button type="button" className={btn} disabled={disabled || !next} onClick={() => next && onSwitch(next, "next")} aria-label={t("versions.next")} title={t("versions.next")}>
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

/** Inline editor for a sent message: Enter or Save sends the new version, Escape (or Cancel) leaves it as it was. */
function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const t = useTranslations("chat");
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const changed = text.trim() && text.trim() !== initial.trim();
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    try {
      await onSave(text.trim());
    } catch {
      // the caller already told the user; keep the draft so nothing typed is lost
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="w-[min(32rem,85vw)] space-y-1.5 text-left">
      <Textarea
        ref={area}
        value={text}
        rows={3}
        aria-label={t("edit.label")}
        aria-describedby={hintId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        disabled={saving}
      />
      <div className="flex items-center justify-end gap-2">
        <span id={hintId} className="mr-auto text-[11px] text-muted-foreground">
          {t("edit.hint")}
        </span>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancel} disabled={saving}>
          {t("edit.cancel")}
        </Button>
        <Button type="button" size="sm" className="h-7" onClick={() => void save()} disabled={!changed || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {t("edit.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * One chat message. Memoised: while a reply streams only that row re-renders. Callers keep the props stable
 * (`m` objects are replaced only when that message changes, `author` comes from the query cache, `onMakeTask`,
 * `names`, `onEdit`, `onRegenerate` and `onSwitch` are stable callbacks).
 *
 * Members get "Edit" on user messages and "Regenerate" on replies (shown on hover and keyboard focus), and every
 * message with other versions gets a "‹ 2/3 ›" switcher.
 */
export const MessageItem = memo(function MessageItem({
  m,
  author,
  color,
  fallbackAvatar,
  teamChat,
  canDecide,
  highlighted,
  onMakeTask,
  names,
  canBranch,
  busy,
  switching,
  onEdit,
  onRegenerate,
  onSwitch,
}: {
  m: ChatMessageDTO;
  author: Employee | undefined;
  /** the author's sign colour (tints the avatar) */
  color?: SignColor;
  fallbackAvatar: string | undefined;
  teamChat: boolean;
  canDecide: boolean;
  highlighted: boolean;
  onMakeTask: (text: string) => void;
  /** employee id → name, for the "not asked" note */
  names: (id: string) => string | undefined;
  /** may edit, regenerate and switch versions (MEMBER and up) */
  canBranch: boolean;
  /** a reply is being written: regenerating has to wait (the server refuses it meanwhile) */
  busy: boolean;
  /** a version switch is in flight: the switchers wait for it */
  switching: boolean;
  onEdit: (messageId: string, content: string) => Promise<unknown>;
  onRegenerate: (messageId: string) => void;
  onSwitch: (messageId: string, dir: "prev" | "next") => void;
}) {
  const t = useTranslations("chat");
  const fmt = useFormat();
  const [editing, setEditing] = useState(false);
  const editBtn = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useLayoutEffect(() => {
    // back on the Edit button after the editor closes, so keyboard users keep their place
    if (!editing && refocus.current) {
      refocus.current = false;
      editBtn.current?.focus();
    }
  }, [editing]);
  if (m.role === "system") return <Receipt m={m} author={author} highlighted={highlighted} names={names} />;
  const mine = m.role === "user";
  const chips = !mine ? (m.meta?.chips ?? []) : [];
  const approvals = !mine ? (m.approvals ?? []) : [];
  return (
    <div id={`msg-${m.id}`} className={cn("group flex gap-3", mine && "flex-row-reverse")}>
      {!mine && <Avatar emoji={author?.avatar ?? fallbackAvatar} color={color} className="mt-0.5" />}
      <div className={cn("min-w-0 max-w-[min(46rem,88%)] space-y-1.5", mine && "items-end text-right")}>
        {!mine && (author || m.meta?.routedBy) && (teamChat || author) && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {author && <span className="font-semibold text-foreground">{author.name}</span>}
            {author && <span className="text-muted-foreground">{author.role}</span>}
            {m.meta?.routedBy && <RoutedByBadge routedBy={m.meta.routedBy} />}
          </div>
        )}
        {editing ? (
          <EditBox
            initial={m.content}
            onCancel={() => {
              refocus.current = true;
              setEditing(false);
            }}
            onSave={async (text) => {
              await onEdit(m.id, text);
              setEditing(false);
            }}
          />
        ) : (
          <div
            className={cn(
              "inline-block whitespace-pre-wrap break-words text-left text-[15px] leading-relaxed transition-shadow",
              mine ? "rounded-2xl rounded-br-md border bg-secondary px-3.5 py-2.5" : "-mx-2 rounded-xl px-2 py-0.5",
              highlighted && "ring-2 ring-ring ring-offset-2 ring-offset-background",
            )}
          >
            {m.content || (
              <span role="status" className="inline-flex">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span className="sr-only">{author ? t("replyingAs", { name: author.name }) : t("replying")}</span>
              </span>
            )}
          </div>
        )}
        {!!m.attachments?.length && (
          <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
            {m.attachments.map((a) => (
              <span key={a.name} className="inline-flex items-center gap-1 rounded-lg border px-2 py-0.5">
                <Paperclip className="size-3" aria-hidden /> {a.name}
              </span>
            ))}
          </div>
        )}
        {!!chips.length && (
          <div className="flex flex-wrap gap-1">
            {chips.map((c, i) => (
              <span key={`${c.tool}-${i}`} className="inline-flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                <Check className="size-3.5" aria-hidden />
                {t("chip", { label: c.label })}
              </span>
            ))}
          </div>
        )}
        {!!approvals.length && (
          <div className="w-[min(36rem,100%)] space-y-2 pt-1.5">
            {approvals.map((a) => (
              <ApprovalCard key={a.id} a={a} compact readOnly={!canDecide} />
            ))}
          </div>
        )}
        {!mine && <SkippedNote ids={m.meta?.skippedResponders ?? []} names={names} />}
        <div className={cn("flex items-center gap-2 text-[11px] text-muted-foreground", mine && "justify-end")}>
          {fmt.ago(m.createdAt)}
          {m.taskId && (
            <Link href={`/tasks/${m.taskId}`} className="text-foreground underline underline-offset-2">
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
          {canBranch && mine && !editing && (
            <button ref={editBtn} type="button" className={hoverAction} onClick={() => setEditing(true)}>
              <Pencil className="size-3" aria-hidden /> {t("edit.action")}
            </button>
          )}
          {canBranch && !mine && !busy && m.content && m.status !== "streaming" && (
            <button type="button" className={hoverAction} onClick={() => onRegenerate(m.id)}>
              <RefreshCw className="size-3" aria-hidden /> {t("regenerate")}
            </button>
          )}
          {m.branch && m.branch.count > 1 && <VersionSwitcher branch={m.branch} disabled={!canBranch || editing || switching} onSwitch={onSwitch} />}
        </div>
      </div>
    </div>
  );
});
