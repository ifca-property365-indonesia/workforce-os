"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Paperclip, Send, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar } from "@/components/layout/common";
import { activeMention, insertMention, MENTION_ALL_WORDS, mentionMatches, mentionSuppressed, type PickedMention } from "@/lib/mentions";
import { cn } from "@/lib/utils";

export interface MentionCandidate {
  id: string;
  name: string;
  avatar: string;
  role: string;
}

interface Option {
  key: string;
  /** inserted after the "@" */
  token: string;
  avatar: string | null;
  sub: string;
}

const MAX_OPTIONS = 8;

/**
 * Message box with attachments. In team chats (`members` set) typing "@" opens a list of the team's members
 * plus @semua / @everyone: arrows move, Enter or Tab inserts "@Name ", Escape closes.
 */
export function Composer({
  members,
  busy,
  sending,
  onSend,
}: {
  members: MentionCandidate[] | null;
  busy: boolean;
  sending: boolean;
  onSend: (text: string, files: File[]) => Promise<unknown>;
}) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const listId = useId();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  /** the "@" position the user closed the list for with Escape */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** the mention just inserted: closed until the user types again ("@Sari " must not reopen for "Sari Dewi") */
  const [picked, setPicked] = useState<PickedMention | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | null>(null);
  /** the draft as it is now, read when a send resolves (the user may have typed on meanwhile) */
  const latestText = useRef(text);
  latestText.current = text;

  const allWord = locale === "id" ? MENTION_ALL_WORDS[0] : MENTION_ALL_WORDS[1];
  const active = members ? activeMention(text, caret) : null;
  let options: Option[] = [];
  if (members && active && !mentionSuppressed(active, text, dismissed, picked)) {
    const q = active.query;
    options = members.filter((m) => mentionMatches(m.name, q)).map((m) => ({ key: m.id, token: m.name, avatar: m.avatar, sub: m.role }));
    if (MENTION_ALL_WORDS.some((w) => mentionMatches(w, q))) options.push({ key: "@all", token: allWord, avatar: null, sub: t("mention.everyone") });
    options = options.slice(0, MAX_OPTIONS);
  }
  const open = options.length > 0;
  const current = open ? Math.min(index, options.length - 1) : 0;

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !areaRef.current) return;
    areaRef.current.focus();
    areaRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  // keep the highlighted option in view when the arrows move past the visible part of the list
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[current] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, current]);

  const pick = (o: Option) => {
    if (!active) return;
    const next = insertMention(text, active, caret, o.token);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setIndex(0);
    setPicked({ start: active.start, text: next.text });
  };

  const canSend = !!text.trim() || !!files.length;
  const submit = () => {
    if (!canSend || sending) return;
    const sentText = text;
    const sentFiles = files;
    void onSend(sentText, sentFiles)
      .then(() => {
        // only clear what was sent: text typed while the request was in flight stays
        if (latestText.current === sentText) {
          setText("");
          setCaret(0);
          setDismissed(null);
          setPicked(null);
        }
        setFiles((cur) => cur.filter((f) => !sentFiles.includes(f)));
      })
      .catch(() => {
        /* the caller shows the error; keep the draft */
      });
  };

  return (
    <form
      className="border-t bg-card p-3 sm:px-5 sm:py-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!!files.length && (
        <div className="mb-2 flex flex-wrap gap-1">
          {files.map((f, i) => (
            <span key={`${f.name}-${f.size}-${i}`} className="inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-xs">
              {f.name}
              <button type="button" onClick={() => setFiles((cur) => cur.filter((x) => x !== f))} aria-label={t("removeFile")}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.md,.txt,.csv,.json"
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            setFiles((cur) => [...cur, ...chosen]);
            // so choosing the same file again (after removing it) fires change again
            e.target.value = "";
          }}
        />
        <Button type="button" size="icon-lg" variant="ghost" onClick={() => fileRef.current?.click()} aria-label={t("attachFiles")}>
          <Paperclip className="size-4" />
        </Button>
        <div className="relative min-w-0 flex-1">
          {open && (
            <ul ref={listRef} id={listId} role="listbox" aria-label={t("mention.listLabel")} className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-72 max-w-full overflow-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-[0_18px_40px_-20px_rgb(0_0_0/0.6)]">
              {options.map((o, i) => (
                <li
                  key={o.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm", i === current && "bg-accent text-accent-foreground")}
                  onMouseEnter={() => setIndex(i)}
                  // mousedown keeps the focus in the textarea
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                >
                  {o.avatar !== null ? (
                    <Avatar id={o.key} size="sm" />
                  ) : (
                    <span className="inline-flex size-6 items-center justify-center rounded-full bg-accent">
                      <Users className="size-3.5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">@{o.token}</span>
                  <span className="truncate text-xs text-muted-foreground">{o.sub}</span>
                </li>
              ))}
            </ul>
          )}
          <Textarea
            ref={areaRef}
            rows={1}
            value={text}
            role={members ? "combobox" : undefined}
            aria-autocomplete={members ? "list" : undefined}
            aria-expanded={members ? open : undefined}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${current}` : undefined}
            aria-label={t("messageLabel")}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setIndex(0);
              setPicked(null);
              if (dismissed !== null && !activeMention(e.target.value, e.target.selectionStart ?? 0)) setDismissed(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setDismissed(active?.start ?? null)}
            onFocus={() => setDismissed(null)}
            onKeyDown={(e) => {
              // Enter / Tab confirm an IME composition (Japanese, Chinese…): never send or pick on them
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (open) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setIndex((current + step + options.length) % options.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                  e.preventDefault();
                  pick(options[current]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setDismissed(active!.start);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={busy ? t("placeholderBusy") : members ? t("placeholderTeam") : t("placeholder")}
            className="max-h-40 min-h-11 resize-none rounded-xl text-[15px]"
          />
        </div>
        <Button type="submit" size="icon-lg" disabled={sending || !canSend} aria-label={t("send")} className="sign rounded-xl hover:brightness-110" data-state="lit">
          <Send className="size-4" />
        </Button>
      </div>
    </form>
  );
}
