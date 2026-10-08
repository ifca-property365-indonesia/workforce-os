"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, UserMinus } from "lucide-react";
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
  workspace: { id: string; name: string; monthlyBudget: number; guardsEnabled: boolean; demoMode: boolean; killSwitch: boolean; notifyEmail: string | null; webhookConfigured: boolean; require2faAdmins: boolean };
  claude: { credentialPresent: boolean; source: "workspace" | "instance" | null; type: "oauth" | "api_key" | null };
}

interface ClaudeStatus {
  workspace: { type: "oauth" | "api_key"; last4: string; updatedAt: string } | null;
  instance: { enabled: boolean; type: "oauth" | "api_key"; present: boolean };
  effective: { source: "workspace" | "instance"; type: "oauth" | "api_key" } | null;
}

const CRED_LABEL = { oauth: "Claude subscription token", api_key: "Anthropic API key" } as const;

/** Owner-managed Claude credential for this workspace. Only type and the last 4 characters are ever shown. */
function ClaudeCredential({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["claude-credential"], queryFn: () => api.get<ClaudeStatus>("/api/settings/claude") });
  const [type, setType] = useState<"oauth" | "api_key">("oauth");
  const [secret, setSecret] = useState("");
  const done = () => {
    setSecret("");
    void qc.invalidateQueries({ queryKey: ["claude-credential"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const save = useMutation({
    mutationFn: () => api.put<ClaudeStatus>("/api/settings/claude", { type, secret }),
    onSuccess: () => {
      toast.success("Claude credential saved (encrypted)");
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.del<ClaudeStatus>("/api/settings/claude"),
    onSuccess: () => {
      toast.success("Claude credential removed");
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Claude credential</CardTitle>
        <CardDescription>
          Each workspace uses its own credential. A run receives only this workspace&apos;s credential, only while it runs. Subscription tokens come from{" "}
          <code>claude setup-token</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <div>
            This workspace:{" "}
            {data.workspace ? (
              <span className="font-medium">
                {CRED_LABEL[data.workspace.type]} · ending in <code>{data.workspace.last4}</code> · set {dateTime(data.workspace.updatedAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">not set</span>
            )}
          </div>
          <div className="text-muted-foreground">
            Server fallback:{" "}
            {!data.instance.enabled ? "disabled by the server owner" : data.instance.present ? `${CRED_LABEL[data.instance.type]} (set in the server .env)` : "not set"}
          </div>
          <div>
            In use:{" "}
            {data.effective ? (
              <span className="text-emerald-600">{data.effective.source === "workspace" ? "this workspace's credential" : "the server fallback"}</span>
            ) : (
              <span className="text-destructive">none — employees cannot run</span>
            )}
          </div>
        </div>
        {owner && (
          <form
            className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="claude-type">Type</Label>
              <select
                id="claude-type"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value as "oauth" | "api_key")}
              >
                <option value="oauth">{CRED_LABEL.oauth}</option>
                <option value="api_key">{CRED_LABEL.api_key}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claude-secret">{data.workspace ? "Replace with" : "Credential"}</Label>
              <Input id="claude-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={type === "oauth" ? "sk-ant-oat…" : "sk-ant-api…"} />
            </div>
            <div className="flex gap-2">
              <Button disabled={secret.trim().length < 20 || save.isPending}>Save</Button>
              {data.workspace && (
                <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => confirm("Remove this workspace's Claude credential?") && remove.mutate()}>
                  Remove
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function General({ s, owner, admin }: { s: Settings; owner: boolean; admin: boolean }) {
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
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Require two-factor authentication for Owners and Admins</span>
              <span className="block text-xs text-muted-foreground">They must set up an authenticator app before they can use the workspace. Only an Owner can change this.</span>
            </span>
            <Switch
              checked={s.workspace.require2faAdmins}
              disabled={!owner}
              onCheckedChange={(v) => (v || confirm("Stop requiring two-factor authentication for Owners and Admins?")) && save.mutate({ require2faAdmins: v })}
            />
          </label>
        </CardContent>
      </Card>
      {admin && <ClaudeCredential owner={owner} />}
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

function Members({ owner, admin, meId }: { owner: boolean; admin: boolean; meId?: string }) {
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
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/api/members?userId=${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["members"] });
      toast.success("Member removed");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reset = useMutation({
    mutationFn: (userId: string) => api.post<{ tempPassword: string }>("/api/members/reset-password", { userId }),
    onSuccess: (r) => prompt("New one-time password (they must change it at next sign-in). Share it securely:", r.tempPassword),
    onError: (e) => toast.error((e as Error).message),
  });
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
            {admin && m.userId !== meId && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2"
                  disabled={(m.role === "OWNER" && !owner) || reset.isPending}
                  onClick={() => confirm(`Reset the password for ${m.email}? Their current password and sessions stop working.`) && reset.mutate(m.userId)}
                  aria-label={`Reset password for ${m.email}`}
                  title="Reset password"
                >
                  <KeyRound className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-destructive hover:text-destructive"
                  disabled={(m.role === "OWNER" && !owner) || remove.isPending}
                  onClick={() => confirm(`Remove ${m.email} from this workspace?`) && remove.mutate(m.userId)}
                  aria-label={`Remove ${m.email}`}
                  title="Remove from workspace"
                >
                  <UserMinus className="size-4" />
                </Button>
              </>
            )}
          </div>
        ))}
        {admin && (
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
        )}
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
          <General s={data} owner={owner} admin={admin} />
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
          <Members owner={owner} admin={admin} meId={me?.user.id} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <Audit />
        </TabsContent>
      </Tabs>
    </div>
  );
}
