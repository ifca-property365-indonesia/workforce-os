"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useMe } from "@/lib/hooks";

interface Settings {
  workspace: { id: string; name: string; monthlyBudget: number; guardsEnabled: boolean; demoMode: boolean; killSwitch: boolean; notifyEmail: string | null; webhookConfigured: boolean };
  claude: { authMode: string; credentialPresent: boolean };
}

function General({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [name, setName] = useState(s.workspace.name);
  const [budget, setBudget] = useState(s.workspace.monthlyBudget);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/api/settings", body),
    onSuccess: () => {
      toast.success("Saved");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Monthly budget (credits; 1 credit = $0.01)</Label>
            <Input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          </div>
          <div>
            <Button onClick={() => save.mutate({ name, monthlyBudget: budget })}>Save</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Safety</CardTitle>
          <CardDescription>Guards are on by default: prompt-injection screening on tool results and secret/PII leakage checks on outputs.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Input & output guards</span>
              <span className="block text-xs text-muted-foreground">Turning this off is audited.</span>
            </span>
            <Switch checked={s.workspace.guardsEnabled} onCheckedChange={(v) => (v || confirm("Disable guards? This is not recommended.")) && save.mutate({ guardsEnabled: v })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Demo mode</span>
              <span className="block text-xs text-muted-foreground">Scripted runs with zero tokens and no network calls; same SSE events.</span>
            </span>
            <Switch checked={s.workspace.demoMode} onCheckedChange={(v) => save.mutate({ demoMode: v })} />
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claude Agent SDK</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          Auth mode: <code>{s.claude.authMode}</code> ({s.claude.authMode === "api_key" ? "ANTHROPIC_API_KEY — multi-user/commercial" : "CLAUDE_CODE_OAUTH_TOKEN — personal/internal"}) ·{" "}
          {s.claude.credentialPresent ? <span className="text-emerald-600">credential configured</span> : <span className="text-destructive">credential missing — set it in the server .env</span>}
        </CardContent>
      </Card>
    </div>
  );
}

function Email() {
  const { data } = useQuery({ queryKey: ["smtp"], queryFn: () => api.get<{ smtp: { host: string; port: number; secure: boolean; user: string; fromAddress: string; passwordSet: boolean } | null }>("/api/settings/smtp") });
  const [f, setF] = useState({ host: "", port: 587, secure: false, user: "", password: "", fromAddress: "" });
  const [to, setTo] = useState("");
  const me = useMe();
  useEffect(() => {
    if (data?.smtp) setF({ ...data.smtp, password: "" });
  }, [data]);
  useEffect(() => {
    if (me.data && !to) setTo(me.data.user.email);
  }, [me.data, to]);
  const save = useMutation({
    mutationFn: () => api.put("/api/settings/smtp", { ...f, password: f.password || undefined }),
    onSuccess: () => toast.success("SMTP saved (password encrypted with AES-256-GCM)"),
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ messageId: string }>("/api/settings/smtp/test", { to }),
    onSuccess: (r) => toast.success(`Test email sent (${r.messageId})`),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SMTP</CardTitle>
        <CardDescription>Used for send_email / send_invoice and notifications. The password never leaves the server.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Host</Label>
          <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.gmail.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Port</Label>
            <Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <Switch checked={f.secure} onCheckedChange={(v) => setF({ ...f, secure: v })} /> TLS (465)
          </label>
        </div>
        <div className="space-y-1.5">
          <Label>User</Label>
          <Input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label>Password {data?.smtp?.passwordSet && <span className="text-xs text-muted-foreground">(set — leave blank to keep)</span>}</Label>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>From address</Label>
          <Input value={f.fromAddress} onChange={(e) => setF({ ...f, fromAddress: e.target.value })} placeholder='"Acme Studio" <hello@acme.com>' />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button onClick={() => save.mutate()} disabled={!f.host || !f.fromAddress}>
            Save
          </Button>
          <Input className="max-w-60" value={to} onChange={(e) => setTo(e.target.value)} placeholder="test recipient" />
          <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !to}>
            {test.isPending ? "Sending…" : "Send test email"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Notifications({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(s.workspace.notifyEmail ?? "");
  const [hook, setHook] = useState("");
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.put("/api/settings", b),
    onSuccess: () => (toast.success("Saved"), void qc.invalidateQueries({ queryKey: ["settings"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notifications</CardTitle>
        <CardDescription>When approvals are waiting or a task finishes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label>Notify email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button onClick={() => save.mutate({ notifyEmail: email })}>Save</Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label>Webhook URL (WhatsApp / Telegram / Slack gateway) {s.workspace.webhookConfigured && <span className="text-xs text-emerald-600">configured</span>}</Label>
            <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://… (stored encrypted)" />
          </div>
          <Button onClick={() => save.mutate({ webhookUrl: hook })} disabled={!hook}>
            Save
          </Button>
          {s.workspace.webhookConfigured && (
            <Button variant="ghost" onClick={() => save.mutate({ webhookUrl: "" })}>
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">The webhook receives JSON <code>{`{"text": "..."}`}</code>. It is also the target of the irreversible <code>post_webhook</code> tool.</p>
      </CardContent>
    </Card>
  );
}

function Integrations() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers: { id: string; name: string; url: string; tokenSet: boolean }[] }>("/api/settings/mcp") });
  const [f, setF] = useState({ name: "", url: "", token: "" });
  const add = useMutation({
    mutationFn: () => api.post("/api/settings/mcp", { ...f, token: f.token || undefined }),
    onSuccess: () => (setF({ name: "", url: "", token: "" }), void qc.invalidateQueries({ queryKey: ["mcp"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({ mutationFn: (name: string) => api.del(`/api/settings/mcp?name=${encodeURIComponent(name)}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp"] }) });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">MCP servers</CardTitle>
        <CardDescription>
          Connect remote (Streamable HTTP) MCP servers. Tokens are encrypted and never sent to the browser or the model. Grant a server per employee as <code>mcp:&lt;name&gt;</code>; its tools are classified by verb (read/list/search = reversible, anything else = irreversible → approval).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.servers.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <code className="font-medium">{s.name}</code>
            <span className="flex-1 truncate text-muted-foreground">{s.url}</span>
            {s.tokenSet && <span className="text-xs text-emerald-600">token set</span>}
            <Button size="sm" variant="ghost" onClick={() => del.mutate(s.name)}>
              Remove
            </Button>
          </div>
        ))}
        <div className="grid gap-2 sm:grid-cols-[140px_1fr_1fr_auto]">
          <Input placeholder="name (e.g. github)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input placeholder="https://…/mcp" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          <Input type="password" placeholder="Bearer token (optional)" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
          <Button onClick={() => add.mutate()} disabled={!f.name || !f.url}>
            Connect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Pricing({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["pricing"],
    queryFn: () =>
      api.get<{
        creditUsd: number;
        models: { model: string; label: string; inputPer1k: number; outputPer1k: number; cacheReadPer1k: number; cacheWritePer1k: number }[];
        tools: { name: string; label: string; class: string; credits: number }[];
      }>("/api/pricing"),
  });
  const [tokIn, setTokIn] = useState(8000);
  const [tokOut, setTokOut] = useState(1500);
  const [calls, setCalls] = useState(5);
  const save = useMutation({
    mutationFn: (m: Record<string, unknown>) => api.put("/api/pricing", m),
    onSuccess: () => (toast.success("Price updated"), void qc.invalidateQueries({ queryKey: ["pricing"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Published price table</CardTitle>
          <CardDescription>1 credit = ${data?.creditUsd ?? 0.01}. Every LLM step is charged from this table, so you can forecast cost before running.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Input / 1K tok</TableHead>
                <TableHead className="text-right">Output / 1K tok</TableHead>
                <TableHead className="text-right">Cache read / 1K</TableHead>
                <TableHead className="text-right">Cache write / 1K</TableHead>
                <TableHead className="text-right">Forecast*</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.models.map((m) => (
                <TableRow key={m.model}>
                  <TableCell>
                    <div className="font-medium">{m.label}</div>
                    <code className="text-xs text-muted-foreground">{m.model}</code>
                  </TableCell>
                  {(["inputPer1k", "outputPer1k", "cacheReadPer1k", "cacheWritePer1k"] as const).map((k) => (
                    <TableCell key={k} className="text-right tabular-nums">
                      {owner ? (
                        <Input
                          type="number"
                          step="0.001"
                          defaultValue={m[k]}
                          className="ml-auto h-8 w-24 text-right"
                          onBlur={(e) => Number(e.target.value) !== m[k] && save.mutate({ ...m, [k]: Number(e.target.value) })}
                        />
                      ) : (
                        m[k]
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">
                    {((tokIn / 1000) * m.inputPer1k + (tokOut / 1000) * m.outputPer1k + calls * 0.1).toFixed(2)} cr
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            *Forecast for a task of
            <Input type="number" className="h-7 w-24" value={tokIn} onChange={(e) => setTokIn(Number(e.target.value))} /> input tokens,
            <Input type="number" className="h-7 w-20" value={tokOut} onChange={(e) => setTokOut(Number(e.target.value))} /> output tokens and
            <Input type="number" className="h-7 w-16" value={calls} onChange={(e) => setCalls(Number(e.target.value))} /> tool calls (0.1 cr avg).
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per tool call</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          {data?.tools.map((t) => (
            <div key={t.name} className="flex justify-between rounded px-2 py-1 odd:bg-muted/40">
              <span>
                {t.label} <span className={t.class === "irreversible" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>({t.class})</span>
              </span>
              <span className="tabular-nums">{t.credits} cr</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Members({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["members"], queryFn: () => api.get<{ members: { userId: string; email: string; name: string; role: string }[] }>("/api/members") });
  const [f, setF] = useState({ email: "", name: "", role: "MEMBER" });
  const add = useMutation({
    mutationFn: () => api.post<{ tempPassword: string | null }>("/api/members", f),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["members"] });
      if (r.tempPassword) prompt("User created. Share this one-time password securely:", r.tempPassword);
      else toast.success("Member added");
      setF({ email: "", name: "", role: "MEMBER" });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const role = useMutation({ mutationFn: (v: { userId: string; role: string }) => api.patch("/api/members", v), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }), onError: (e) => toast.error((e as Error).message) });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Members</CardTitle>
        <CardDescription>Owner: everything incl. allow-lists & pricing · Admin: employees, approvals, settings · Member: tasks, chat, clients · Viewer: read-only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.members.map((m) => (
          <div key={m.userId} className="flex items-center gap-2 text-sm">
            <span className="flex-1">
              {m.name} <span className="text-muted-foreground">{m.email}</span>
            </span>
            <select disabled={!owner} className="h-8 rounded-md border bg-background px-2 text-sm" value={m.role} onChange={(e) => role.mutate({ userId: m.userId, role: e.target.value })}>
              {["OWNER", "ADMIN", "MEMBER", "VIEWER"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_1fr_120px_auto]">
          <Input placeholder="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Input placeholder="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {["ADMIN", "MEMBER", "VIEWER", ...(owner ? ["OWNER"] : [])].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <Button onClick={() => add.mutate()} disabled={!f.email || !f.name}>
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Audit() {
  const { data } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<{ entries: { id: string; actorLabel: string; action: string; targetType: string; targetId: string | null; details: Record<string, unknown>; createdAt: string }[] }>("/api/audit"),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>Immutable (append-only, enforced by a database trigger): approvals, permission changes, credential changes, kill-switch use.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {data?.entries.map((e) => (
          <details key={e.id} className="rounded border px-3 py-2 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{dateTime(e.createdAt)}</span>
              <code className="rounded bg-muted px-1.5 text-xs">{e.action}</code>
              <span>{e.actorLabel}</span>
              <span className="text-xs text-muted-foreground">
                {e.targetType} {e.targetId?.slice(0, 8)}
              </span>
            </summary>
            <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(e.details, null, 2)}</pre>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const { data: me } = useMe();
  const admin = me?.role === "OWNER" || me?.role === "ADMIN";
  const owner = me?.role === "OWNER";
  if (!data) return null;
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs defaultValue="general">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">General</TabsTrigger>
          {admin && <TabsTrigger value="email">Email</TabsTrigger>}
          {admin && <TabsTrigger value="notifications">Notifications</TabsTrigger>}
          {admin && <TabsTrigger value="integrations">Integrations</TabsTrigger>}
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          {admin && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="general" className="mt-4">
          <General s={data} />
        </TabsContent>
        <TabsContent value="email" className="mt-4">
          <Email />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <Notifications s={data} />
        </TabsContent>
        <TabsContent value="integrations" className="mt-4">
          <Integrations />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <Pricing owner={owner} />
        </TabsContent>
        <TabsContent value="members" className="mt-4">
          <Members owner={owner} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <Audit />
        </TabsContent>
      </Tabs>
    </div>
  );
}
