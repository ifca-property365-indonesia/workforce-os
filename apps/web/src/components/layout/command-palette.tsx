"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Bot, Building2, FileText, KanbanSquare, Plus, Rocket, Search, ShieldCheck, UsersRound, type LucideIcon } from "lucide-react";
import type { TaskStatus } from "@wfos/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { APPS } from "@/components/desktop/routes";
import { api } from "@/lib/api";
import { useDecisionCount } from "@/lib/hooks";
import { useOpen } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** GET /api/search (lib/server/search.ts) */
interface SearchResults {
  tasks: { id: string; title: string; status: TaskStatus }[];
  employees: { id: string; name: string; role: string }[];
  divisions: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  apps: { id: string; name: string; slug: string }[];
  documents: { id: string; name: string }[];
}

/** the server searches from this many characters (SEARCH_MIN_CHARS) */
const MIN_CHARS = 2;
const DEBOUNCE_MS = 180;

interface Entry {
  key: string;
  group: string;
  icon: LucideIcon;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * Ctrl/⌘ K: find a page, task, employee, division, client, app or document of this workspace and open it, or start a
 * new task with what was typed. Arrow keys move, Enter opens, Esc closes.
 */
export function CommandPalette({ open, onOpenChange, onNewTask }: { open: boolean; onOpenChange: (o: boolean) => void; onNewTask: (title: string) => void }) {
  const t = useTranslations("nav.search");
  const tn = useTranslations("nav.items");
  const ts = useTranslations("status.task");
  const go = useOpen();
  const decisions = useDecisionCount();
  const listId = useId();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);
  // a fresh palette every time it opens
  useEffect(() => {
    if (!open) return;
    setQ("");
    setDebounced("");
    setActive(0);
  }, [open]);

  const { data: found, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= MIN_CHARS,
    staleTime: 15_000,
  });

  const entries = useMemo(() => {
    const close = (fn: () => void) => () => {
      onOpenChange(false);
      fn();
    };
    const needle = q.trim().toLowerCase();
    const out: Entry[] = [];
    const typed = q.trim();
    out.push({ key: "new-task", group: t("groups.actions"), icon: Plus, label: typed ? t("newTaskWith", { text: typed }) : t("newTask"), run: close(() => onNewTask(typed)) });
    if (decisions > 0 && (!needle || t("decisions", { count: decisions }).toLowerCase().includes(needle)))
      out.push({ key: "decisions", group: t("groups.actions"), icon: ShieldCheck, label: t("decisions", { count: decisions }), run: close(() => go("/approvals")) });
    for (const a of APPS) {
      const label = tn(a.key);
      if (needle && !label.toLowerCase().includes(needle)) continue;
      out.push({ key: `page:${a.key}`, group: t("groups.pages"), icon: a.icon, label, run: close(() => go(a.href)) });
    }
    if (found && debounced === typed) {
      for (const x of found.tasks) out.push({ key: `task:${x.id}`, group: t("groups.tasks"), icon: KanbanSquare, label: x.title, hint: ts(x.status), run: close(() => go(`/tasks/${x.id}`)) });
      for (const x of found.employees) out.push({ key: `emp:${x.id}`, group: t("groups.employees"), icon: Bot, label: x.name, hint: x.role, run: close(() => go(`/employees/${x.id}`)) });
      for (const x of found.divisions) out.push({ key: `div:${x.id}`, group: t("groups.divisions"), icon: UsersRound, label: x.name, run: close(() => go("/teams")) });
      for (const x of found.clients) out.push({ key: `client:${x.id}`, group: t("groups.clients"), icon: Building2, label: x.name, run: close(() => go(`/clients/${x.id}`)) });
      for (const x of found.apps) out.push({ key: `app:${x.id}`, group: t("groups.apps"), icon: Rocket, label: x.name, hint: x.slug, run: close(() => go(`/apps/${x.id}`)) });
      for (const x of found.documents) out.push({ key: `doc:${x.id}`, group: t("groups.documents"), icon: FileText, label: x.name, run: close(() => go("/knowledge")) });
    }
    return out;
  }, [q, debounced, found, decisions, t, tn, ts, go, onNewTask, onOpenChange]);

  // keep the highlight on a real row as the list changes
  useEffect(() => setActive((i) => Math.min(i, Math.max(0, entries.length - 1))), [entries.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      entries[active]?.run();
    }
  };

  const searching = q.trim().length >= MIN_CHARS && (isFetching || debounced !== q.trim());
  const rows: ReactNode[] = [];
  let lastGroup = "";
  entries.forEach((en, i) => {
    if (en.group !== lastGroup) {
      lastGroup = en.group;
      rows.push(
        <li key={`g:${en.group}`} role="presentation" className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-1">
          {en.group}
        </li>,
      );
    }
    rows.push(
      <li
        key={en.key}
        id={`${listId}-${i}`}
        role="option"
        aria-selected={i === active}
        data-index={i}
        onMouseMove={() => setActive(i)}
        onClick={en.run}
        className={cn("mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm", i === active ? "bg-secondary text-foreground" : "text-foreground/90")}
      >
        <en.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{en.label}</span>
        {en.hint && <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{en.hint}</span>}
      </li>,
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            placeholder={t("placeholder")}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={entries.length ? `${listId}-${active}` : undefined}
            aria-label={t("title")}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {searching && <span className="text-xs text-muted-foreground">{t("searching")}</span>}
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label={t("title")} className="max-h-[min(60vh,28rem)] overflow-y-auto pb-1.5">
          {rows}
        </ul>
        {q.trim().length >= MIN_CHARS && !searching && found && !found.tasks.length && !found.employees.length && !found.divisions.length && !found.clients.length && !found.apps.length && !found.documents.length && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">{t("nothingFound")}</p>
        )}
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">{t("keys")}</p>
      </DialogContent>
    </Dialog>
  );
}

/** Ctrl/⌘ K anywhere in the app opens the palette. */
export function useCommandPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
