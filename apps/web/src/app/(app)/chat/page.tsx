"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KanbanSquare, Loader2, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import type { ChatMessageDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useRealtime } from "@/lib/events";
import { ago } from "@/lib/format";
import { useEmployees, useTeams } from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface Conv {
  id: string;
  title: string;
  employeeId: string | null;
  teamId: string | null;
  updatedAt: string;
}
interface Msg extends ChatMessageDTO {
  status?: string;
}

function TaskFromChat({ text, employeeId, onClose }: { text: string; employeeId: string | null; onClose: () => void }) {
  const [title, setTitle] = useState(text.split("\n")[0]!.slice(0, 100));
  const [brief, setBrief] = useState(text);
  const m = useMutation({
    mutationFn: () => api.post<{ task: { id: string } }>("/api/tasks", { title, brief, assigneeId: employeeId, start: true }),
    onSuccess: (r) => {
      toast.success("Task created", { action: { label: "Open", onClick: () => (location.href = `/tasks/${r.task.id}`) } });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create task from chat</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Brief</Label>
            <Textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={!title || !employeeId || m.isPending}>
            Create & start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatView({ conv }: { conv: Conv }) {
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const key = ["conversation", conv.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ messages: Msg[] }>(`/api/conversations/${conv.id}`) });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [taskFrom, setTaskFrom] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (data) setMessages(data.messages.map((m) => ({ ...m, createdAt: String(m.createdAt) })));
  }, [data]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useRealtime((ev) => {
    if (ev.type === "chat.message" && ev.message.conversationId === conv.id) {
      setMessages((ms) => {
        const i = ms.findIndex((m) => m.id === ev.message.id);
        if (i === -1) return [...ms, ev.message];
        const copy = [...ms];
        // keep streamed text if the final message has not arrived yet
        copy[i] = { ...ev.message, content: ev.message.content || copy[i]!.content };
        return copy;
      });
    }
    if (ev.type === "chat.delta" && ev.conversationId === conv.id) {
      setMessages((ms) => ms.map((m) => (m.id === ev.messageId ? { ...m, content: m.content + ev.text, status: "streaming" } : m)));
    }
  });

  const send = useMutation({
    mutationFn: () => {
      const f = new FormData();
      f.set("content", text);
      for (const file of files) f.append("files", file);
      return api.form(`/api/conversations/${conv.id}/messages`, f);
    },
    onSuccess: () => {
      setText("");
      setFiles([]);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const emp = conv.employeeId ? emps?.find((e) => e.id === conv.employeeId) : undefined;
  const team = conv.teamId ? teams?.find((t) => t.id === conv.teamId) : undefined;
  const leadId = emp?.id ?? team?.leadId ?? null;
  const busy = messages.some((m) => m.role === "assistant" && (m.status === "streaming" || (m.status === undefined && !m.content)));

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Avatar emoji={emp?.avatar ?? "👥"} />
        <div className="min-w-0">
          <div className="truncate font-medium">{emp?.name ?? team?.name ?? "Chat"}</div>
          <div className="truncate text-xs text-muted-foreground">{emp ? `${emp.role} · ${emp.autonomyLevel}` : "Team chat (answered by the Lead)"}</div>
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {!messages.length && <p className="pt-10 text-center text-sm text-muted-foreground">Say hello, ask a question, or describe work to turn into a task.</p>}
        {messages.map((m) => {
          const mine = m.role === "user";
          const author = m.employeeId ? emps?.find((e) => e.id === m.employeeId) : undefined;
          return (
            <div key={m.id} className={cn("flex gap-2", mine && "flex-row-reverse")}>
              {!mine && <Avatar emoji={author?.avatar ?? emp?.avatar} size="sm" className="mt-1" />}
              <div className={cn("max-w-[85%] space-y-1", mine && "items-end text-right")}>
                <div className={cn("inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-sm", mine ? "bg-primary text-primary-foreground" : "bg-muted")}>
                  {m.content || <Loader2 className="size-4 animate-spin" />}
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
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {ago(m.createdAt)}
                  {m.taskId && (
                    <Link href={`/tasks/${m.taskId}`} className="text-primary hover:underline">
                      task created
                    </Link>
                  )}
                  {!mine && m.content && (
                    <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => setTaskFrom(m.content)}>
                      <KanbanSquare className="size-3" /> Create task
                    </button>
                  )}
                  {mine && (
                    <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => setTaskFrom(m.content)}>
                      <KanbanSquare className="size-3" /> Make task
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() || files.length) send.mutate();
        }}
      >
        {!!files.length && (
          <div className="mb-2 flex flex-wrap gap-1">
            {files.map((f) => (
              <span key={f.name} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs">
                {f.name}
                <button type="button" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label="Remove file">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.md,.txt,.csv,.json" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
          <Button type="button" size="icon" variant="ghost" onClick={() => fileRef.current?.click()} aria-label="Attach files">
            <Paperclip className="size-4" />
          </Button>
          <Textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (text.trim() || files.length) send.mutate();
              }
            }}
            placeholder={busy ? "Waiting for the reply…" : "Message (Enter to send, Shift+Enter for newline)"}
            className="max-h-40 min-h-10 resize-none"
          />
          <Button type="submit" size="icon" disabled={send.isPending || (!text.trim() && !files.length)} aria-label="Send">
            <Send className="size-4" />
          </Button>
        </div>
      </form>
      {taskFrom !== null && <TaskFromChat text={taskFrom} employeeId={leadId} onClose={() => setTaskFrom(null)} />}
    </div>
  );
}

function ChatPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const { data } = useQuery({ queryKey: ["conversations"], queryFn: () => api.get<{ conversations: Conv[] }>("/api/conversations").then((r) => r.conversations) });
  const selected = sp.get("c");
  const conv = data?.find((c) => c.id === selected) ?? null;

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
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <div className="space-y-3">
        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center gap-1 text-sm font-medium">
            <Plus className="size-4" /> New chat
          </div>
          <div className="flex flex-wrap gap-1.5">
            {emps
              ?.filter((e) => e.status !== "ARCHIVED")
              .map((e) => (
                <Button key={e.id} size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => create.mutate({ employeeId: e.id })}>
                  {e.avatar} {e.name}
                </Button>
              ))}
            {teams
              ?.filter((t) => t.leadId)
              .map((t) => (
                <Button key={t.id} size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => create.mutate({ teamId: t.id })}>
                  👥 {t.name}
                </Button>
              ))}
          </div>
        </div>
        <div className="space-y-1">
          {data?.map((c) => {
            const e = c.employeeId ? emps?.find((x) => x.id === c.employeeId) : undefined;
            return (
              <div key={c.id} className={cn("group flex items-center gap-2 rounded-lg px-2 py-2 text-sm", c.id === selected ? "bg-primary/10" : "hover:bg-accent")}>
                <Link href={`/chat?c=${c.id}`} className="flex min-w-0 flex-1 items-center gap-2">
                  <span>{e?.avatar ?? "👥"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.title}</span>
                    <span className="block text-[11px] text-muted-foreground">{e?.name ?? "Team"} · {ago(c.updatedAt)}</span>
                  </span>
                </Link>
                <button type="button" className="opacity-0 group-hover:opacity-100" onClick={() => del.mutate(c.id)} aria-label="Delete chat">
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {conv ? <ChatView key={conv.id} conv={conv} /> : <EmptyState title="Pick a conversation" description="Start a new chat with any employee or team on the left." />}
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
