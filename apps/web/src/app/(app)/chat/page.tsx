"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { AlertOctagon, ChevronLeft, Loader2, Plus, Trash2, UsersRound } from "lucide-react";
import { hasRole, type ChatMessageDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState } from "@/components/layout/common";
import { Composer, type MentionCandidate } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { OfficeFacade, useBotMoods, useSignColors } from "@/components/office/employee-sign";
import { PendingApprovalsList, usePendingApprovals } from "@/components/approvals/pending-list";
import type { IncidentRow } from "@/components/inspector/incidents-card";
import { api, ApiError } from "@/lib/api";
import { applyRealtimeMessage, mergeMessages } from "@/lib/chat-thread";
import { useRealtime } from "@/lib/events";
import { useFormat } from "@/lib/use-format";
import { useEmployees, useMe, useTeams, type Employee } from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface Conv {
  id: string;
  title: string;
  employeeId: string | null;
  teamId: string | null;
  updatedAt: string;
}
/** GET /api/conversations/[id] (and POST …/branch): the active branch only */
interface Thread {
  conversation: Conv;
  messages: Msg[];
  activeLeafId: string | null;
}
interface Msg extends ChatMessageDTO {
  status?: string;
}

function TaskFromChat({ text, employeeId, onClose }: { text: string; employeeId: string | null; onClose: () => void }) {
  const t = useTranslations("chat");
  const [title, setTitle] = useState(text.split("\n")[0]!.slice(0, 100));
  const [brief, setBrief] = useState(text);
  const uid = useId();
  const m = useMutation({
    mutationFn: () => api.post<{ task: { id: string } }>("/api/tasks", { title, brief, assigneeId: employeeId, start: true }),
    onSuccess: (r) => {
      toast.success(t("taskDialog.created"), { action: { label: t("taskDialog.open"), onClick: () => (location.href = `/tasks/${r.task.id}`) } });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("taskDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-title`}>{t("taskDialog.titleLabel")}</Label>
            <Input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-brief`}>{t("taskDialog.brief")}</Label>
            <Textarea id={`${uid}-brief`} rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!title || !employeeId || m.isPending}>
            {t("taskDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AWAIT_MS = 90_000;
/** how long a smooth scroll to a new message may take before "is the reader at the bottom?" is believed again */
const SMOOTH_SCROLL_MS = 1500;

function ChatView({ conv, focusMessageId }: { conv: Conv; focusMessageId: string | null }) {
  const t = useTranslations("chat");
  const ts = useTranslations("status");
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const key = ["conversation", conv.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<Thread>(`/api/conversations/${conv.id}`) });
  const [messages, setMessagesState] = useState<Msg[]>([]);
  /**
   * The rows as last set, read synchronously: realtime events can arrive several per render, and deciding whether
   * one continues the thread from the rendered `messages` would miss rows an earlier event just added.
   */
  const shown = useRef<Msg[]>([]);
  const setMessages = useCallback((fn: (ms: Msg[]) => Msg[]) => {
    const next = fn(shown.current);
    if (next === shown.current) return;
    shown.current = next;
    setMessagesState(next);
  }, []);
  /** a version switch: the sibling to focus the switcher of once its branch is shown, and how to announce it */
  const switchFocus = useRef<{ id: string; dir: "prev" | "next" } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [taskFrom, setTaskFrom] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  /**
   * The newest user message has no reply row yet. In auto-routed team chats the first reply row appears only after
   * the classifier picked a responder (up to a few seconds), so the composer shows "waiting" until any reply,
   * receipt or hint arrives (or 90 s pass).
   */
  const [awaiting, setAwaiting] = useState(false);
  /** when a regenerate was asked for: the old reply stays visible until the new one arrives, the composer waits */
  const [regenAt, setRegenAt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  /**
   * Follow new messages only while the reader is at the bottom (not while they read an approval further up):
   * `stick` is "the bottom sentinel is visible", watched by an IntersectionObserver. While our own smooth scroll
   * is under way the sentinel is briefly out of view; that does not count as the reader leaving.
   */
  const stick = useRef(true);
  const sentinelVisible = useRef(true);
  const smoothUntil = useRef(0);
  const smoothTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shownCount = useRef(0);
  const anchor = useRef<string | null>(focusMessageId);
  const [anchorSeq, setAnchorSeq] = useState(0);

  useEffect(() => {
    const root = scroller.current;
    const target = bottom.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        sentinelVisible.current = entry.isIntersecting;
        if (entry.isIntersecting) stick.current = true;
        else if (Date.now() > smoothUntil.current) stick.current = false;
      },
      { root, rootMargin: "0px 0px 80px 0px" },
    );
    io.observe(target);
    return () => {
      io.disconnect();
      clearTimeout(smoothTimer.current);
    };
  }, []);

  // a new ?m= (another notification clicked) while this conversation stays open: scroll to and highlight it too
  useEffect(() => {
    if (!focusMessageId || anchor.current === focusMessageId) return;
    anchor.current = focusMessageId;
    setAnchorSeq((n) => n + 1);
  }, [focusMessageId]);

  useEffect(() => {
    if (data) setMessages((local) => mergeMessages(data.messages.map((m) => ({ ...m, createdAt: String(m.createdAt) })), local));
  }, [data, setMessages]);
  // layout effect: the scroll lands before paint, so a growing reply never pushes the sentinel out of view
  useLayoutEffect(() => {
    // after a version switch the row with the switcher is a different message (remounted): keep the keyboard on it
    const sw = switchFocus.current;
    if (sw) {
      const group = document.getElementById(`msg-${sw.id}`)?.querySelector<HTMLElement>("[data-version-switcher]");
      if (group) {
        switchFocus.current = null;
        const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
        const preferred = sw.dir === "prev" ? buttons[0] : buttons.at(-1);
        (preferred && !preferred.disabled ? preferred : (buttons.find((b) => !b.disabled) ?? group)).focus();
      }
    }
    const added = messages.length > shownCount.current;
    const firstPaint = shownCount.current === 0;
    shownCount.current = messages.length;
    if (anchor.current) {
      const target = anchor.current;
      const el = document.getElementById(`msg-${target}`);
      if (el) {
        anchor.current = null;
        stick.current = false;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlight(target);
        return;
      }
      // a deep link to a message that is not (or no longer) in this conversation: behave as usual
      if (data && !data.messages.some((m) => m.id === target)) anchor.current = null;
      else return;
    }
    // opening a thread with a decision waiting: start at that approval (its amber strip in view), not at the bottom
    if (firstPaint && messages.length) {
      const waiting = [...messages].reverse().find((m) => m.approvals?.some((a) => a.status === "PENDING"));
      const card = waiting && document.getElementById(waiting.approvals!.find((a) => a.status === "PENDING")!.id);
      if (card) {
        stick.current = false;
        card.scrollIntoView({ behavior: "auto", block: "start" });
        return;
      }
    }
    if (!stick.current) return;
    // a new message glides in; streamed text and the first render jump, so the view keeps up with every delta
    if (added && !firstPaint) {
      smoothUntil.current = Date.now() + SMOOTH_SCROLL_MS;
      clearTimeout(smoothTimer.current);
      smoothTimer.current = setTimeout(() => {
        // the reader scrolled away during the animation: the observer saw no change since, so settle it here
        if (!sentinelVisible.current) stick.current = false;
      }, SMOOTH_SCROLL_MS);
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      bottom.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [messages, data, anchorSeq]);
  const last = messages.at(-1);
  /** the thread's end as this view knows it: what an edit says it acted on (`expectedLeafId`) */
  const lastId = useRef<string | null>(null);
  lastId.current = last?.id ?? null;
  useEffect(() => {
    if (!last) return;
    const lastAt = new Date(last.createdAt).getTime();
    // waiting for the newest user message's reply, or for a regenerated reply newer than everything shown
    const since = last.role === "user" ? lastAt : regenAt > lastAt ? regenAt : 0;
    const age = Math.max(0, Date.now() - since);
    const waiting = since > 0 && age < AWAIT_MS;
    setAwaiting(waiting);
    if (!waiting) return;
    const timer = setTimeout(() => setAwaiting(false), AWAIT_MS - age);
    return () => clearTimeout(timer);
  }, [last?.id, last?.role, last?.createdAt, regenAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(timer);
  }, [highlight]);

  const refetch = () => void qc.invalidateQueries({ queryKey: key });
  useRealtime((ev) => {
    if (ev.type === "chat.message" && ev.message.conversationId === conv.id) {
      // decided against the rows as they are now (not as last rendered): see applyRealtimeMessage
      let again = false;
      setMessages((ms) => {
        const r = applyRealtimeMessage(ms, ev.message as Msg);
        again = r.refetch;
        return r.messages;
      });
      if (again) refetch();
    }
    if (ev.type === "chat.delta" && ev.conversationId === conv.id) {
      setMessages((ms) => (ms.some((m) => m.id === ev.messageId) ? ms.map((m) => (m.id === ev.messageId ? { ...m, content: m.content + ev.text, status: "streaming" } : m)) : ms));
    }
    if (ev.type === "approval.created" && ev.conversationId === conv.id) refetch();
    if (ev.type === "approval.updated" && shown.current.some((m) => m.approvals?.some((a) => a.id === ev.approvalId))) refetch();
  });

  /** 409 conversation_changed: someone (or another tab) moved the thread on; show it as it is now */
  const branchError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409 && (e.data as { code?: string } | undefined)?.code === "conversation_changed") {
      toast(t("conversationChanged"));
      refetch();
      return;
    }
    toast.error((e as Error).message);
  };
  const send = useMutation({
    mutationFn: ({ text, files }: { text: string; files: File[] }) => {
      const f = new FormData();
      f.set("content", text);
      // the message answers what this view shows: if the thread moved on meanwhile (another tab switched versions,
      // an edit forked it), the server refuses with 409 instead of hanging it below a branch nobody here sees
      f.set("expectedLeafId", lastId.current ?? "");
      for (const file of files) f.append("files", file);
      return api.form(`/api/conversations/${conv.id}/messages`, f);
    },
    onSuccess: () => {
      // the sender wants to see their own message (and the reply), wherever they had scrolled to
      stick.current = true;
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    // the composer keeps the draft whenever the send fails
    onError: branchError,
  });
  const afterBranch = () => {
    stick.current = true;
    refetch();
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };
  const edit = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api.patch(`/api/conversations/${conv.id}/messages/${id}`, { content, expectedLeafId: lastId.current }),
    onSuccess: afterBranch,
    onError: branchError,
  });
  const regenerate = useMutation({
    mutationFn: (id: string) => api.post(`/api/conversations/${conv.id}/messages/${id}/regenerate`),
    onSuccess: () => {
      setRegenAt(Date.now());
      afterBranch();
    },
    onError: branchError,
  });
  /**
   * Version switch. The active leaf is shared: it is stored on the conversation, so every viewer (and the next
   * message, which hangs below it) follows the switch — there is one "current" thread, not one per person.
   */
  const switchTo = useMutation({
    mutationFn: ({ messageId }: { messageId: string; dir: "prev" | "next" }) => api.post<Thread>(`/api/conversations/${conv.id}/branch`, { messageId }),
    onMutate: ({ messageId, dir }) => {
      switchFocus.current = { id: messageId, dir };
    },
    // the answer is the new branch: show it straight away (the merge drops the rows of the old one). A refetch
    // still in flight would land after it with the old branch, so it is cancelled first.
    onSuccess: async (r, { messageId }) => {
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData(key, r);
      const b = r.messages.find((m) => m.id === messageId)?.branch;
      if (b) setAnnounce(t("versions.label", { index: b.index + 1, count: b.count }));
    },
    onError: (e) => {
      switchFocus.current = null;
      branchError(e);
    },
  });
  const editAsync = edit.mutateAsync;
  const regenerateMutate = regenerate.mutate;
  const switchMutate = switchTo.mutate;
  const onEdit = useCallback((id: string, content: string) => editAsync({ id, content }), [editAsync]);
  const onRegenerate = useCallback((id: string) => regenerateMutate(id), [regenerateMutate]);
  const onSwitch = useCallback((id: string, dir: "prev" | "next") => switchMutate({ messageId: id, dir }), [switchMutate]);

  const emp = conv.employeeId ? emps?.find((e) => e.id === conv.employeeId) : undefined;
  const team = conv.teamId ? teams?.find((t) => t.id === conv.teamId) : undefined;
  const leadId = emp?.id ?? team?.leadId ?? null;
  const busy = awaiting || messages.some((m) => m.role === "assistant" && (m.status === "streaming" || (m.status === undefined && !m.content)));
  const canDecide = !!me && hasRole(me.role, "ADMIN");
  const canBranch = !!me && hasRole(me.role, "MEMBER");
  const empById = useMemo(() => new Map((emps ?? []).map((e) => [e.id, e])), [emps]);
  const nameOf = useCallback((id: string) => empById.get(id)?.name, [empById]);
  const members: MentionCandidate[] | null = team
    ? [...new Set([...(team.leadId ? [team.leadId] : []), ...team.memberIds])]
        .map((id) => empById.get(id))
        .filter((e): e is Employee => !!e && e.status !== "ARCHIVED")
        .map((e) => ({ id: e.id, name: e.name, avatar: e.avatar, role: e.role }))
    : null;

  const colors = useSignColors();
  const facadeIds = team ? (members ?? []).map((x) => x.id) : emp ? [emp.id] : [];

  return (
    <section aria-label={emp?.name ?? team?.name ?? t("fallbackTitle")} className="flex h-[calc(100dvh-var(--chrome,3.5rem)-2.5rem)] lg:h-[calc(100dvh-var(--chrome,3.5rem)-3.5rem)] min-h-[34rem] flex-col overflow-hidden rounded-2xl border bg-card">
      <header className="border-b px-4 pt-4 sm:px-5">
        <Link href="/chat" className="mb-2 inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground md:hidden">
          <ChevronLeft className="size-4" aria-hidden /> {t("conversations")}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 className="font-display truncate text-[2rem]">{emp?.name ?? team?.name ?? t("fallbackTitle")}</h2>
            <p className="mt-1 hidden truncate text-sm text-muted-foreground sm:block">
              {emp ? `${emp.role} · ${ts(`autonomy.${emp.autonomyLevel}`)}` : t(`teamMode.${team?.responderMode ?? "lead"}`)}
            </p>
          </div>
        </div>
        {!!facadeIds.length && <OfficeFacade ids={facadeIds} leadId={team?.leadId} size="sm" className="mt-3 sm:hidden" />}
        {!!facadeIds.length && <OfficeFacade ids={facadeIds} leadId={team?.leadId} size="md" className="mt-3 hidden sm:flex" />}
      </header>
      <div ref={scroller} role="log" aria-live="polite" aria-label={t("threadLabel")} className="flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6">
        {!messages.length && <p className="pt-10 text-center text-sm text-muted-foreground">{t("emptyThread")}</p>}
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            m={m}
            author={m.employeeId ? empById.get(m.employeeId) : undefined}
            color={m.employeeId ? colors.get(m.employeeId) : emp ? colors.get(emp.id) : undefined}
            fallbackId={emp?.id}
            teamChat={!!conv.teamId}
            canDecide={canDecide}
            highlighted={highlight === m.id}
            onMakeTask={setTaskFrom}
            names={nameOf}
            canBranch={canBranch}
            busy={busy || regenerate.isPending}
            switching={switchTo.isPending}
            onEdit={onEdit}
            onRegenerate={onRegenerate}
            onSwitch={onSwitch}
          />
        ))}
        {awaiting && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" /> {t("waitingReply")}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      <Composer members={members} busy={busy} sending={send.isPending} onSend={(text, files) => send.mutateAsync({ text, files })} />
      {taskFrom !== null && <TaskFromChat text={taskFrom} employeeId={leadId} onClose={() => setTaskFrom(null)} />}
    </section>
  );
}

const OPEN_INCIDENT = new Set(["open", "handling", "escalated"]);

/** Beside the thread on wide screens: what is waiting for you across the office, and what is broken. */
function ChatContext() {
  const t = useTranslations("chat");
  const fmt = useFormat();
  const { data: emps } = useEmployees();
  const live = (emps ?? []).filter((e) => e.status !== "ARCHIVED");
  const spent = live.reduce((n, e) => n + (e.spentToday ?? 0), 0);
  const cap = live.reduce((n, e) => n + e.dailyBudget, 0);
  const { data: pending } = usePendingApprovals();
  const { data: inc } = useQuery({
    queryKey: ["incidents"],
    queryFn: () => api.get<{ incidents: IncidentRow[]; resolved7d: number }>("/api/incidents"),
    refetchInterval: 60_000,
  });
  const incidents = (inc?.incidents ?? []).filter((i) => OPEN_INCIDENT.has(i.status));
  return (
    <aside aria-label={t("context.title")} className="hidden h-[calc(100dvh-var(--chrome,3.5rem)-2.5rem)] lg:h-[calc(100dvh-var(--chrome,3.5rem)-3.5rem)] min-h-[34rem] flex-col gap-6 overflow-y-auto rounded-2xl border bg-card p-5 xl:flex">
      <h2 className="font-display text-[1.6rem]">{t("context.title")}</h2>
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{t("context.approvals")}</h3>
          <span className="font-display text-[1.9rem] text-approval">{pending?.length ?? "…"}</span>
        </div>
        <PendingApprovalsList approvals={pending} empty={t("context.noApprovals")} />
        {!!pending?.length && (
          <Link href="/approvals" className="mt-2 inline-block text-xs font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {t("context.openInbox")}
          </Link>
        )}
      </div>
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{t("context.incidents")}</h3>
          <span className={cn("font-display text-[1.9rem]", incidents.length ? "text-destructive" : "text-muted-foreground")}>{inc ? incidents.length : "…"}</span>
        </div>
        {inc && !incidents.length && <p className="text-sm text-muted-foreground">{t("context.noIncidents")}</p>}
        <ul className="space-y-2">
          {incidents.slice(0, 4).map((i) => (
            <li key={i.id} className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <div className="flex items-center gap-1.5 font-semibold text-destructive">
                <AlertOctagon className="size-3.5 shrink-0" aria-hidden /> {i.employee?.name ?? ""}
              </div>
              <p className="mt-0.5 line-clamp-3 text-foreground/85">{i.summary}</p>
              {i.task && (
                <Link href={`/tasks/${i.task.id}`} className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  {i.task.title}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
      {cap > 0 && (
        <div className="mt-auto border-t pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-muted-foreground">{t("context.cost")}</h3>
            <span className="font-display text-[1.6rem] tabular-nums">{fmt.credits(spent)}</span>
          </div>
          <Progress value={Math.min(100, (spent / cap) * 100)} className="mt-2 h-1.5" />
          <p className="mt-1.5 text-xs text-muted-foreground">{t("context.ofCap", { cap: fmt.credits(cap) })}</p>
        </div>
      )}
    </aside>
  );
}

function ChatPage() {
  const t = useTranslations("chat");
  const fmt = useFormat();
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const moods = useBotMoods();
  const { data: teams } = useTeams();
  const { data } = useQuery({ queryKey: ["conversations"], queryFn: () => api.get<{ conversations: Conv[] }>("/api/conversations").then((r) => r.conversations) });
  const selected = sp.get("c");
  const listed = data?.find((c) => c.id === selected);
  // a deep link (notification) can point at a conversation older than the 100 listed
  const { data: direct } = useQuery({
    queryKey: ["conversation", selected],
    queryFn: () => api.get<{ conversation: Conv; messages: ChatMessageDTO[] }>(`/api/conversations/${selected}`),
    enabled: !!selected && !!data && !listed,
    retry: false,
  });
  const conv = listed ?? (direct?.conversation.id === selected ? direct.conversation : null);

  const create = useMutation({
    mutationFn: (v: { employeeId?: string; teamId?: string }) => api.post<{ conversation: Conv }>("/api/conversations", v),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      router.replace(`/chat?c=${r.conversation.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/conversations/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      router.replace("/chat");
    },
  });

  const wantEmp = sp.get("employee");
  const started = useRef(false);
  useEffect(() => {
    if (wantEmp && data && !started.current) {
      started.current = true;
      const existing = data.find((c) => c.employeeId === wantEmp);
      if (existing) router.replace(`/chat?c=${existing.id}`);
      else create.mutate({ employeeId: wantEmp });
    }
  }, [wantEmp, data, router, create]);

  return (
    <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_19rem] [&>*]:min-w-0">
      {/* on a phone an open conversation takes the screen; its header links back to this list */}
      <div className={cn("flex-col gap-4 md:flex md:h-[calc(100dvh-var(--chrome,3.5rem)-2.5rem)] lg:h-[calc(100dvh-var(--chrome,3.5rem)-3.5rem)] md:min-h-[34rem]", conv ? "hidden" : "flex")}>
        <div className="rounded-2xl border bg-card p-3">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Plus className="size-4" aria-hidden /> {t("newChat")}
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {emps
              ?.filter((e) => e.status !== "ARCHIVED")
              .map((e) => (
                <Button key={e.id} size="sm" variant="outline" className="gap-1.5 px-2" onClick={() => create.mutate({ employeeId: e.id })}>
                  <Avatar id={e.id} size="sm" className="size-5 p-0" /> {e.name}
                </Button>
              ))}
            {teams
              ?.filter((t) => t.leadId)
              .map((t) => (
                <Button key={t.id} size="sm" variant="outline" className="gap-1.5 px-2" onClick={() => create.mutate({ teamId: t.id })}>
                  <UsersRound className="size-4" aria-hidden /> {t.name}
                </Button>
              ))}
          </div>
        </div>
        <nav aria-label={t("conversations")} className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {data?.map((c) => {
            const e = c.employeeId ? emps?.find((x) => x.id === c.employeeId) : undefined;
            const active = c.id === selected;
            return (
              <div key={c.id} className={cn("group flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm", active ? "bg-secondary" : "hover:bg-secondary/60")}>
                <Link href={`/chat?c=${c.id}`} aria-current={active ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-2.5">
                  {e ? (
                    <Avatar id={e.id} size="sm" mood={moods.get(e.id)} />
                  ) : (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent">
                      <UsersRound className="size-4" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{c.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {e?.name ?? t("team")} · {fmt.ago(c.updatedAt)}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  className="rounded-lg p-1 opacity-0 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                  onClick={() => del.mutate(c.id)}
                  aria-label={t("deleteChat")}
                  title={t("deleteChat")}
                >
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </button>
              </div>
            );
          })}
        </nav>
      </div>
      {conv ? <ChatView key={conv.id} conv={conv} focusMessageId={sp.get("m")} /> : <EmptyState title={t("empty.title")} description={t("empty.description")} />}
      <ChatContext />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
