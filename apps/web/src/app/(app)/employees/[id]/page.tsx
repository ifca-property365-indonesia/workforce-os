"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, MessageSquare, Pause, Play, Plus, Trash2, FlaskConical } from "lucide-react";
import type { AllowListEntry, AutonomyLevel, ToolPermission } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AutonomyBadge, StatusBadge } from "@/components/layout/common";
import { AutonomyPicker, ToolPermissionsEditor } from "@/components/employees/tool-permissions";
import { DiffView } from "@/components/inspector/task-detail";
import { api } from "@/lib/api";
import { ago, credits } from "@/lib/format";
import { useMe, useTemplates, type Employee, type TaskRow } from "@/lib/hooks";

type P = { params: Promise<{ id: string }> };

interface Replay {
  id: string;
  status: string;
  proposed: { instructions: string; persona: string; businessContext: string };
  results: { taskId: string; title: string; oldOutput: string; newOutput: string; diff: string; credits: number }[];
  costCredits: number;
  error: string | null;
  createdAt: string;
}

function InstructionsTab({ e }: { e: Employee }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ persona: e.persona, instructions: e.instructions, businessContext: e.businessContext });
  const [sample, setSample] = useState(3);
  const dirty = form.persona !== e.persona || form.instructions !== e.instructions || form.businessContext !== e.businessContext;
  const { data } = useQuery({ queryKey: ["replays", e.id], queryFn: () => api.get<{ replays: Replay[] }>(`/api/employees/${e.id}/replay`), refetchInterval: (q) => (q.state.data?.replays.some((r) => r.status === "queued" || r.status === "running") ? 3000 : false) });
  const latest = data?.replays.find((r) => ["queued", "running", "done", "failed"].includes(r.status));
  const start = useMutation({
    mutationFn: () => api.post(`/api/employees/${e.id}/replay`, { ...form, sampleSize: sample }),
    onSuccess: () => {
      toast.success("Replay started on past tasks (dry run, no side effects)");
      void qc.invalidateQueries({ queryKey: ["replays", e.id] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; action: "promote" | "discard" }) => api.post(`/api/replays/${v.id}`, { action: v.action }),
    onSuccess: (_r, v) => {
      toast.success(v.action === "promote" ? "New instructions promoted" : "Proposal discarded");
      void qc.invalidateQueries({ queryKey: ["replays", e.id] });
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  const saveDirect = useMutation({
    mutationFn: () => api.patch(`/api/employees/${e.id}`, form),
    onSuccess: () => {
      toast.success("Saved without replay");
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
    },
    onError: (x) => toast.error((x as Error).message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-4 p-5 lg:grid-cols-2">
          <div className="space-y-1.5 lg:col-span-2">
            <Label>Persona</Label>
            <Textarea rows={2} value={form.persona} onChange={(x) => setForm({ ...form, persona: x.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Instructions (v{e.instructionsVersion})</Label>
            <Textarea rows={12} className="font-mono text-xs" value={form.instructions} onChange={(x) => setForm({ ...form, instructions: x.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Business context</Label>
            <Textarea rows={12} value={form.businessContext} onChange={(x) => setForm({ ...form, businessContext: x.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
            <Label className="text-xs">Replay on last</Label>
            <Input type="number" min={1} max={10} value={sample} onChange={(x) => setSample(Number(x.target.value))} className="h-8 w-16" />
            <span className="text-xs text-muted-foreground">completed tasks</span>
            <Button disabled={!dirty || start.isPending} onClick={() => start.mutate()} className="gap-1.5">
              <FlaskConical className="size-4" /> Preview change on past tasks
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty}
              onClick={() => confirm("Save without comparing against past tasks?") && saveDirect.mutate()}
            >
              Save without replay
            </Button>
          </div>
        </CardContent>
      </Card>

      {latest && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Replay {latest.status === "running" || latest.status === "queued" ? "in progress…" : latest.status}</CardTitle>
            <CardDescription>
              Old vs new output on {latest.results.length} past task(s) · {credits(latest.costCredits)} credits · {ago(latest.createdAt)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {latest.error && <p className="text-sm text-destructive">{latest.error}</p>}
            {latest.results.map((r) => (
              <div key={r.taskId} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between text-sm font-medium">
                  <Link href={`/tasks/${r.taskId}`} className="hover:underline">
                    {r.title}
                  </Link>
                  <span className="text-xs text-muted-foreground">{credits(r.credits)} cr</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Current instructions</div>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{r.oldOutput}</pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Proposed instructions</div>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-primary/5 p-2 text-xs">{r.newOutput}</pre>
                  </div>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">Unified diff</summary>
                  <DiffView diff={r.diff} />
                </details>
              </div>
            ))}
            {latest.status === "done" && (
              <div className="flex gap-2">
                <Button onClick={() => decide.mutate({ id: latest.id, action: "promote" })}>Promote new instructions</Button>
                <Button variant="outline" onClick={() => decide.mutate({ id: latest.id, action: "discard" })}>
                  Discard
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AllowListEditor({ e, canEdit }: { e: Employee; canEdit: boolean }) {
  const qc = useQueryClient();
  const [list, setList] = useState<AllowListEntry[]>(e.allowList);
  const irreversible = e.toolPermissions.filter((p) => p.enabled && ["send_email", "send_invoice", "post_webhook"].includes(p.tool) || p.tool.startsWith("mcp:"));
  const save = useMutation({
    mutationFn: () => api.patch(`/api/employees/${e.id}`, { allowList: list }),
    onSuccess: () => {
      toast.success("Allow-list saved (audited)");
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Owner allow-list</CardTitle>
        <CardDescription>
          Only applies at CLOSE autonomy. Matching irreversible actions run without per-action approval; anything outside the scope still stops at an approval. {canEdit ? "" : "Only Owners can edit."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.map((entry, i) => (
          <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-4">
            <Select disabled={!canEdit} value={entry.tool} onValueChange={(v) => setList(list.map((x, j) => (j === i ? { ...x, tool: v } : x)))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {irreversible.map((p) => (
                  <SelectItem key={p.tool} value={p.tool}>
                    {p.tool}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              disabled={!canEdit}
              placeholder="recipient domains (comma)"
              value={entry.recipientDomains.join(", ")}
              onChange={(x) => setList(list.map((y, j) => (j === i ? { ...y, recipientDomains: x.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : y)))}
            />
            <Input
              disabled={!canEdit}
              type="number"
              placeholder="max amount (invoices)"
              value={entry.maxAmount ?? ""}
              onChange={(x) => setList(list.map((y, j) => (j === i ? { ...y, maxAmount: x.target.value ? Number(x.target.value) : undefined } : y)))}
            />
            <Button variant="ghost" disabled={!canEdit} onClick={() => setList(list.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {canEdit && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!irreversible.length}
              onClick={() => setList([...list, { tool: irreversible[0]!.tool, recipientDomains: [], clientIds: [] }])}
              className="gap-1"
            >
              <Plus className="size-3.5" /> Add scope
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              Save allow-list
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolsTab({ e }: { e: Employee }) {
  const qc = useQueryClient();
  const { data: tpl } = useTemplates();
  const { data: me } = useMe();
  const { data: mcp } = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers: { name: string }[] }>("/api/settings/mcp").catch(() => ({ servers: [] })) });
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(e.autonomyLevel);
  const [perms, setPerms] = useState<ToolPermission[]>(e.toolPermissions);
  const [budget, setBudget] = useState(e.dailyBudget);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/employees/${e.id}`, { autonomyLevel: autonomy, toolPermissions: perms, dailyBudget: budget }),
    onSuccess: () => {
      toast.success("Permissions saved (audited)");
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  if (!tpl) return null;
  return (
    <div className="space-y-5">
      <AutonomyPicker value={autonomy} onChange={setAutonomy} />
      <div className="flex items-end gap-3">
        <div className="space-y-1.5">
          <Label>Daily budget (credits)</Label>
          <Input type="number" min={0} value={budget} onChange={(x) => setBudget(Number(x.target.value))} className="w-40" />
        </div>
      </div>
      <ToolPermissionsEditor tools={tpl.tools} value={perms} onChange={setPerms} defaultAutonomy={autonomy} extraServers={mcp?.servers.map((s) => s.name)} />
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        Save permissions
      </Button>
      <AllowListEditor e={e} canEdit={me?.role === "OWNER"} />
    </div>
  );
}

function MemoryTab({ e }: { e: Employee }) {
  const qc = useQueryClient();
  const key = ["memories", e.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ memories: { id: string; kind: string; content: string; source: string; createdAt: string }[] }>(`/api/employees/${e.id}/memories`) });
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({ mutationFn: () => api.post(`/api/employees/${e.id}/memories`, { content: text, kind: "fact" }), onSuccess: () => (setText(""), inv()) });
  const upd = useMutation({ mutationFn: (v: { id: string; content: string }) => api.patch(`/api/memories/${v.id}`, { content: v.content }), onSuccess: () => (setEditing(null), inv()) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/memories/${id}`), onSuccess: () => inv() });
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input placeholder="Teach a fact, e.g. 'Kopi Nusantara prefers English'" value={text} onChange={(x) => setText(x.target.value)} />
        <Button disabled={text.length < 2} onClick={() => add.mutate()}>
          Add
        </Button>
      </div>
      {data?.memories.map((m) => (
        <div key={m.id} className="flex items-start gap-3 rounded-lg border p-3">
          <span className={m.kind === "feedback" ? "rounded bg-amber-500/15 px-1.5 text-[11px] uppercase text-amber-700" : "rounded bg-muted px-1.5 text-[11px] uppercase"}>{m.kind}</span>
          <div className="min-w-0 flex-1">
            {editing?.id === m.id ? (
              <div className="flex gap-2">
                <Textarea value={editing.content} onChange={(x) => setEditing({ ...editing, content: x.target.value })} />
                <Button size="sm" onClick={() => upd.mutate(editing)}>
                  Save
                </Button>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-sm" onDoubleClick={() => setEditing({ id: m.id, content: m.content })}>
                {m.content}
              </p>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              from {m.source} · {ago(m.createdAt)} · double-click to edit
            </div>
          </div>
          <Button size="icon" variant="ghost" onClick={() => del.mutate(m.id)} aria-label="Delete memory">
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {!data?.memories.length && <p className="text-sm text-muted-foreground">No memories yet. Rejection feedback from the Approvals inbox lands here automatically.</p>}
    </div>
  );
}

export default function EmployeePage({ params }: P) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["employee", id], queryFn: () => api.get<{ employee: Employee }>(`/api/employees/${id}`).then((r) => r.employee) });
  const { data: tasks } = useQuery({ queryKey: ["tasks", "employee", id], queryFn: () => api.get<{ tasks: TaskRow[] }>(`/api/tasks?employeeId=${id}&limit=20`).then((r) => r.tasks) });
  const status = useMutation({
    mutationFn: (s: "ACTIVE" | "PAUSED") => api.post(`/api/employees/${id}/status`, { status: s }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["employee", id] }),
    onError: (x) => toast.error((x as Error).message),
  });
  const archive = useMutation({ mutationFn: () => api.del(`/api/employees/${id}`), onSuccess: () => (location.href = "/employees") });
  const [k, setK] = useState(0);
  useEffect(() => {
    setK((x) => x + 1);
  }, [data?.instructionsVersion, data?.autonomyLevel]);
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const e = data;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar emoji={e.avatar} size="lg" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{e.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {e.role} · {e.model} · <AutonomyBadge level={e.autonomyLevel} /> · <span className={e.status === "ACTIVE" ? "text-emerald-600" : "text-amber-600"}>{e.status}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild className="gap-1.5">
            <Link href={`/chat?employee=${e.id}`}>
              <MessageSquare className="size-4" /> Chat
            </Link>
          </Button>
          {e.status === "ACTIVE" ? (
            <Button variant="outline" onClick={() => status.mutate("PAUSED")} className="gap-1.5">
              <Pause className="size-4" /> Pause
            </Button>
          ) : (
            <Button onClick={() => status.mutate("ACTIVE")} className="gap-1.5">
              <Play className="size-4" /> Resume
            </Button>
          )}
          <Button variant="ghost" onClick={() => confirm(`Archive ${e.name}?`) && archive.mutate()} aria-label="Archive">
            <Archive className="size-4" />
          </Button>
        </div>
      </div>
      {e.status === "PAUSED_BUDGET" && (
        <div className="rounded-md bg-amber-500/15 p-3 text-sm text-amber-800 dark:text-amber-200">
          Paused because a budget cap was reached. Raise the daily budget under “Tools & autonomy” (or the workspace monthly budget), then Resume.
        </div>
      )}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="instructions">Instructions & replay</TabsTrigger>
          <TabsTrigger value="tools">Tools & autonomy</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="p-4 text-sm">
                <div className="text-xs uppercase text-muted-foreground">Spent today</div>
                <div className="text-xl font-semibold">
                  {credits(e.spentToday)} <span className="text-sm font-normal text-muted-foreground">/ {credits(e.dailyBudget)} cr</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-sm">
                <div className="text-xs uppercase text-muted-foreground">Tools granted</div>
                <div className="text-xl font-semibold">{e.toolPermissions.filter((p) => p.enabled).length}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-sm">
                <div className="text-xs uppercase text-muted-foreground">Instructions version</div>
                <div className="text-xl font-semibold">v{e.instructionsVersion}</div>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {tasks?.map((t) => (
                <Link key={t.id} href={`/tasks/${t.id}`} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="text-xs text-muted-foreground">{credits(t.costCredits)} cr</span>
                  <StatusBadge status={t.status} />
                </Link>
              ))}
              {!tasks?.length && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="instructions" className="mt-4">
          <InstructionsTab key={k} e={e} />
        </TabsContent>
        <TabsContent value="tools" className="mt-4">
          <ToolsTab key={k} e={e} />
        </TabsContent>
        <TabsContent value="memory" className="mt-4">
          <MemoryTab e={e} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
