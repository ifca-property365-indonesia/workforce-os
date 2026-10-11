"use client";

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { History, Pencil, Trash2, Undo2 } from "lucide-react";
import { hasRole } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { dateInput, memoryPatch } from "@/lib/memory-edit";
import { useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

type MemoryState = "active" | "expired" | "superseded";
interface Memory {
  id: string;
  kind: string;
  content: string;
  source: string;
  untrusted: boolean;
  expiresAt: string | null;
  supersededBy: string | null;
  createdAt: string;
  state: MemoryState;
}
interface MemoryEvent {
  id: string;
  memoryId: string | null;
  action: string;
  actor: string;
  actorName: string | null;
  before: { content?: string } | null;
  after: { content?: string } | null;
  undoneAt: string | null;
  createdAt: string;
}

const STATE_TONE: Record<MemoryState, string> = {
  active: "",
  expired: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  superseded: "bg-muted text-muted-foreground",
};

function MemoryHistory({ employeeId }: { employeeId: string }) {
  const t = useTranslations("employees");
  const f = useFormat();
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: ["memory-events", employeeId],
    queryFn: ({ pageParam }) =>
      api.get<{ events: MemoryEvent[]; nextCursor: string | null }>(`/api/employees/${employeeId}/memory-events?limit=30${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const undo = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.post<{ expiryCleared?: boolean }>(`/api/memory-events/${id}/undo${force ? "?force=1" : ""}`),
    onSuccess: (r) => {
      toast.success(r.expiryCleared ? t("memory.history.undoneExpiryCleared") : t("memory.history.undone"));
      void qc.invalidateQueries({ queryKey: ["memories", employeeId] });
      void qc.invalidateQueries({ queryKey: ["memory-events", employeeId] });
    },
    onError: (x, v) => {
      // the memory changed after this entry: say so, and let the person throw the later change away on purpose
      if (x instanceof ApiError && x.status === 409 && (x.data as { code?: string } | undefined)?.code === "memory_changed_since") {
        toast.warning(x.message, { action: { label: t("memory.history.undoAnyway"), onClick: () => undo.mutate({ id: v.id, force: true }) } });
        return;
      }
      toast.error((x as Error).message);
    },
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  const actorLabel = (e: MemoryEvent) => (e.actor === "user" && e.actorName ? e.actorName : t.has(`memory.history.actor.${e.actor}`) ? t(`memory.history.actor.${e.actor}`) : e.actor);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("memory.history.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!events.length && !q.isLoading && <p className="text-sm text-muted-foreground">{t("memory.history.empty")}</p>}
        {events.map((e) => {
          const before = e.before?.content;
          const after = e.after?.content;
          return (
            <div key={e.id} className={cn("flex items-start gap-3 rounded-md border p-2 text-sm", e.undoneAt && "opacity-60")}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-muted px-1.5 text-[11px] uppercase">{t.has(`memory.history.action.${e.action}`) ? t(`memory.history.action.${e.action}`) : e.action}</span>
                  <span className="text-xs text-muted-foreground">{t("memory.history.by", { actor: actorLabel(e), when: f.ago(e.createdAt) })}</span>
                  {e.undoneAt && <span className="text-xs text-muted-foreground">{t("memory.history.undoneAt", { when: f.ago(e.undoneAt) })}</span>}
                </div>
                {before !== undefined && after !== undefined && before !== after ? (
                  <div className="space-y-0.5 text-xs">
                    <del className="block decoration-muted-foreground/60">{before}</del>
                    <ins className="block no-underline">{after}</ins>
                  </div>
                ) : (
                  <div className="truncate text-xs">{after ?? before ?? ""}</div>
                )}
              </div>
              {!e.undoneAt && e.memoryId && (
                <Button size="sm" variant="outline" className="gap-1" disabled={undo.isPending} onClick={() => undo.mutate({ id: e.id })}>
                  <Undo2 className="size-3.5" /> {t("memory.history.undo")}
                </Button>
              )}
            </div>
          );
        })}
        {q.hasNextPage && (
          <Button size="sm" variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t("memory.history.more")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function MemoryPanel({ employeeId }: { employeeId: string }) {
  const t = useTranslations("employees");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canEdit = !!me && hasRole(me.role, "MEMBER");
  const key = ["memories", employeeId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ memories: Memory[] }>(`/api/employees/${employeeId}/memories`) });
  const [text, setText] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** `expiresWas`: the date input as it opened, so a save only touches the expiry when the person changed it */
  const [editing, setEditing] = useState<{ id: string; content: string; expires: string; expiresWas: string } | null>(null);
  const inv = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["memory-events", employeeId] });
  };
  const onError = (x: unknown) => toast.error((x as Error).message);
  const add = useMutation({ mutationFn: () => api.post(`/api/employees/${employeeId}/memories`, { content: text, kind: "fact" }), onSuccess: () => (setText(""), inv()), onError });
  const upd = useMutation({
    mutationFn: (v: { id: string; content: string; expires: string; expiresWas: string }) => api.patch(`/api/memories/${v.id}`, memoryPatch(v)),
    onSuccess: () => (setEditing(null), inv()),
    onError,
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/memories/${id}`), onSuccess: () => inv(), onError });
  const all = data?.memories ?? [];
  const inactive = all.filter((m) => m.state !== "active").length;
  const shown = showInactive ? all : all.filter((m) => m.state === "active");
  const startEdit = (m: Memory) => canEdit && setEditing({ id: m.id, content: m.content, expires: dateInput(m.expiresAt), expiresWas: dateInput(m.expiresAt) });

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex gap-2">
          <Input placeholder={t("memory.placeholder")} value={text} onChange={(x) => setText(x.target.value)} />
          <Button disabled={text.length < 2 || add.isPending} onClick={() => add.mutate()}>
            {tc("add")}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} /> {t("memory.showInactive", { count: inactive })}
        </label>
        {canEdit && (
          <Button size="sm" variant={showHistory ? "secondary" : "ghost"} className="gap-1" onClick={() => setShowHistory(!showHistory)}>
            <History className="size-3.5" /> {t("memory.history.title")}
          </Button>
        )}
      </div>
      {showHistory && <MemoryHistory employeeId={employeeId} />}
      {shown.map((m) => (
        <div key={m.id} className={cn("flex items-start gap-3 rounded-lg border p-3", m.state !== "active" && "opacity-70")}>
          <div className="flex flex-col items-start gap-1">
            <span className={m.kind === "feedback" ? "rounded bg-amber-500/15 px-1.5 text-[11px] uppercase text-amber-700" : "rounded bg-muted px-1.5 text-[11px] uppercase"}>
              {t.has(`memory.kind.${m.kind}`) ? t(`memory.kind.${m.kind}`) : m.kind}
            </span>
            {m.state !== "active" && <span className={cn("rounded px-1.5 text-[11px]", STATE_TONE[m.state])}>{t(`memory.state.${m.state}`)}</span>}
            {m.untrusted && (
              <span className="rounded bg-destructive/10 px-1.5 text-[11px] text-destructive" title={t("memory.untrustedHelp")}>
                {t("memory.untrusted")}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {editing?.id === m.id ? (
              <form
                className="space-y-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  upd.mutate(editing);
                }}
              >
                <Textarea value={editing.content} onChange={(x) => setEditing({ ...editing, content: x.target.value })} />
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`expires-${m.id}`} className="text-xs">
                      {t("memory.expiresLabel")}
                    </Label>
                    <Input id={`expires-${m.id}`} type="date" className="h-8 w-44" value={editing.expires} onChange={(x) => setEditing({ ...editing, expires: x.target.value })} />
                  </div>
                  {editing.expires && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing({ ...editing, expires: "" })}>
                      {t("memory.noExpiry")}
                    </Button>
                  )}
                  <Button size="sm" disabled={editing.content.trim().length < 2 || upd.isPending}>
                    {tc("save")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    {tc("cancel")}
                  </Button>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap text-sm" onDoubleClick={() => startEdit(m)}>
                {m.content}
              </p>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              {t("memory.metaShort", { source: t.has(`memory.source.${m.source}`) ? t(`memory.source.${m.source}`) : m.source, when: f.ago(m.createdAt) })}
              {m.expiresAt && ` · ${m.state === "expired" ? t("memory.expiredOn", { date: f.date(m.expiresAt) }) : t("memory.expiresOn", { date: f.date(m.expiresAt) })}`}
            </div>
          </div>
          {canEdit && editing?.id !== m.id && (
            <div className="flex">
              <Button size="icon" variant="ghost" onClick={() => startEdit(m)} aria-label={t("memory.edit")}>
                <Pencil className="size-4" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => del.mutate(m.id)} aria-label={t("memory.delete")}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          )}
        </div>
      ))}
      {!shown.length && <p className="text-sm text-muted-foreground">{t("memory.empty")}</p>}
    </div>
  );
}
