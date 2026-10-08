"use client";

import { RepositoriesSettings } from "@/components/settings/repositories";
import { DepartmentsSettings } from "@/components/settings/departments";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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
import { useFormat } from "@/lib/use-format";
import { useMe } from "@/lib/hooks";

interface Settings {
  workspace: { id: string; name: string; monthlyBudget: number; guardsEnabled: boolean; demoMode: boolean; killSwitch: boolean; notifyEmail: string | null; webhookConfigured: boolean; require2faAdmins: boolean; defaultLocale: "id" | "en" | null; timezone: string };
  claude: { credentialPresent: boolean; source: "workspace" | "instance" | null; type: "oauth" | "api_key" | null };
}

/** Time zones the browser knows, with the current one first; Indonesian zones are listed first. */
function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [current];
  const first = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC"];
  return [...new Set([current, ...first, ...all])];
}

interface ClaudeStatus {
  workspace: { type: "oauth" | "api_key"; last4: string; updatedAt: string } | null;
  instance: { enabled: boolean; type: "oauth" | "api_key"; present: boolean };
  effective: { source: "workspace" | "instance"; type: "oauth" | "api_key" } | null;
}

/** Owner-managed Claude credential for this workspace. Only type and the last 4 characters are ever shown. */
function ClaudeCredential({ owner }: { owner: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const f = useFormat();
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
      toast.success(t("claude.savedToast"));
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.del<ClaudeStatus>("/api/settings/claude"),
    onSuccess: () => {
      toast.success(t("claude.removedToast"));
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("claude.title")}</CardTitle>
        <CardDescription>{t.rich("claude.description", { code: (c) => <code>{c}</code> })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <div>
            {t("claude.thisWorkspace")}{" "}
            {data.workspace ? (
              <span className="font-medium">
                {t.rich("claude.workspaceSet", {
                  label: t(`claude.type.${data.workspace.type}`),
                  last4: data.workspace.last4,
                  when: f.dateTime(data.workspace.updatedAt),
                  code: (c) => <code>{c}</code>,
                })}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("claude.notSet")}</span>
            )}
          </div>
          <div className="text-muted-foreground">
            {t("claude.serverFallback")}{" "}
            {!data.instance.enabled
              ? t("claude.fallbackDisabled")
              : data.instance.present
                ? t("claude.fallbackSet", { label: t(`claude.type.${data.instance.type}`) })
                : t("claude.notSet")}
          </div>
          <div>
            {t("claude.inUse")}{" "}
            {data.effective ? (
              <span className="text-emerald-600">{data.effective.source === "workspace" ? t("claude.inUseWorkspace") : t("claude.inUseFallback")}</span>
            ) : (
              <span className="text-destructive">{t("claude.inUseNone")}</span>
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
              <Label htmlFor="claude-type">{t("claude.typeLabel")}</Label>
              <select
                id="claude-type"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value as "oauth" | "api_key")}
              >
                <option value="oauth">{t("claude.type.oauth")}</option>
                <option value="api_key">{t("claude.type.api_key")}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claude-secret">{data.workspace ? t("claude.replaceWith") : t("claude.credential")}</Label>
              {/* i18n-ignore: credential prefixes */}
              <Input id="claude-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={type === "oauth" ? "sk-ant-oat…" : "sk-ant-api…"} />
            </div>
            <div className="flex gap-2">
              <Button disabled={secret.trim().length < 20 || save.isPending}>{tc("save")}</Button>
              {data.workspace && (
                <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => confirm(t("claude.removeConfirm")) && remove.mutate()}>
                  {tc("remove")}
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
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const qc = useQueryClient();
  const [name, setName] = useState(s.workspace.name);
  const [budget, setBudget] = useState(s.workspace.monthlyBudget);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/api/settings", body),
    onSuccess: () => {
      toast.success(tc("saved"));
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("workspace.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{tc("name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("workspace.monthlyBudget")}</Label>
            <Input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          </div>
          <div className="sm:col-span-2">
            <Button onClick={() => save.mutate({ name, monthlyBudget: budget })}>{tc("save")}</Button>
          </div>
          <div className="space-y-1.5 border-t pt-3 sm:col-span-2">
            <Label htmlFor="workspace-locale">{t("workspace.language")}</Label>
            <select
              id="workspace-locale"
              className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
              value={s.workspace.defaultLocale ?? ""}
              disabled={save.isPending}
              onChange={(e) => {
                const v = e.target.value;
                const value = v === "id" || v === "en" ? v : null;
                if (value === s.workspace.defaultLocale) return;
                save.mutate({ defaultLocale: value }, { onSuccess: () => window.location.reload() });
              }}
            >
              <option value="">{t("workspace.languageFollowBrowser")}</option>
              <option value="id">{ts("outputLanguage.id")}</option>
              <option value="en">{ts("outputLanguage.en")}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t("workspace.languageDescription")}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="workspace-timezone">{t("workspace.timezone")}</Label>
            <select
              id="workspace-timezone"
              className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
              value={s.workspace.timezone}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ timezone: e.target.value })}
            >
              {timeZones(s.workspace.timezone).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("workspace.timezoneDescription")}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("safety.title")}</CardTitle>
          <CardDescription>{t("safety.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">{t("safety.guards")}</span>
              <span className="block text-xs text-muted-foreground">{t("safety.guardsHint")}</span>
            </span>
            <Switch checked={s.workspace.guardsEnabled} onCheckedChange={(v) => (v || confirm(t("safety.guardsDisableConfirm"))) && save.mutate({ guardsEnabled: v })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">{t("safety.demoMode")}</span>
              <span className="block text-xs text-muted-foreground">{t("safety.demoModeHint")}</span>
            </span>
            <Switch checked={s.workspace.demoMode} onCheckedChange={(v) => save.mutate({ demoMode: v })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">{t("safety.require2fa")}</span>
              <span className="block text-xs text-muted-foreground">{t("safety.require2faHint")}</span>
            </span>
            <Switch
              checked={s.workspace.require2faAdmins}
              disabled={!owner}
              onCheckedChange={(v) => (v || confirm(t("safety.require2faDisableConfirm"))) && save.mutate({ require2faAdmins: v })}
            />
          </label>
        </CardContent>
      </Card>
      {admin && <ClaudeCredential owner={owner} />}
    </div>
  );
}

function Email() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
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
    onSuccess: () => toast.success(t("email.savedToast")),
    onError: (e) => toast.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ messageId: string }>("/api/settings/smtp/test", { to }),
    onSuccess: (r) => toast.success(t("email.testSent", { messageId: r.messageId })),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SMTP</CardTitle>
        <CardDescription>{t("email.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("email.host")}</Label>
          {/* i18n-ignore: example host name */}
          <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.gmail.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>{t("email.port")}</Label>
            <Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <Switch checked={f.secure} onCheckedChange={(v) => setF({ ...f, secure: v })} /> {t("email.tls")}
          </label>
        </div>
        <div className="space-y-1.5">
          <Label>{t("email.user")}</Label>
          <Input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label>
            {tc("password")} {data?.smtp?.passwordSet && <span className="text-xs text-muted-foreground">{t("email.passwordSet")}</span>}
          </Label>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{t("email.fromAddress")}</Label>
          {/* i18n-ignore: example sender address */}
          <Input value={f.fromAddress} onChange={(e) => setF({ ...f, fromAddress: e.target.value })} placeholder='"Acme Studio" <hello@acme.com>' />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button onClick={() => save.mutate()} disabled={!f.host || !f.fromAddress}>
            {tc("save")}
          </Button>
          <Input className="max-w-60" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("email.testRecipient")} />
          <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !to}>
            {test.isPending ? t("email.sending") : t("email.sendTest")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Notifications({ s }: { s: Settings }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const [email, setEmail] = useState(s.workspace.notifyEmail ?? "");
  const [hook, setHook] = useState("");
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.put("/api/settings", b),
    onSuccess: () => (toast.success(tc("saved")), void qc.invalidateQueries({ queryKey: ["settings"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("notifications.title")}</CardTitle>
        <CardDescription>{t("notifications.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label>{t("notifications.notifyEmail")}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button onClick={() => save.mutate({ notifyEmail: email })}>{tc("save")}</Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label>
              {t("notifications.webhookUrl")} {s.workspace.webhookConfigured && <span className="text-xs text-emerald-600">{t("notifications.configured")}</span>}
            </Label>
            <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder={t("notifications.webhookPlaceholder")} />
          </div>
          <Button onClick={() => save.mutate({ webhookUrl: hook })} disabled={!hook}>
            {tc("save")}
          </Button>
          {s.workspace.webhookConfigured && (
            <Button variant="ghost" onClick={() => save.mutate({ webhookUrl: "" })}>
              {tc("remove")}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t.rich("notifications.webhookHelp", { payload: '{"text": "..."}', code: (c) => <code>{c}</code> })}</p>
      </CardContent>
    </Card>
  );
}

function Integrations() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
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
        <CardTitle className="text-base">{t("integrations.title")}</CardTitle>
        <CardDescription>{t.rich("integrations.description", { grant: "mcp:<name>", code: (c) => <code>{c}</code> })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.servers.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <code className="font-medium">{s.name}</code>
            <span className="flex-1 truncate text-muted-foreground">{s.url}</span>
            {s.tokenSet && <span className="text-xs text-emerald-600">{t("integrations.tokenSet")}</span>}
            <Button size="sm" variant="ghost" onClick={() => del.mutate(s.name)}>
              {tc("remove")}
            </Button>
          </div>
        ))}
        <div className="grid gap-2 sm:grid-cols-[140px_1fr_1fr_auto]">
          <Input placeholder={t("integrations.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          {/* i18n-ignore: example URL */}
          <Input placeholder="https://…/mcp" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          <Input type="password" placeholder={t("integrations.tokenPlaceholder")} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
          <Button onClick={() => add.mutate()} disabled={!f.name || !f.url}>
            {t("integrations.connect")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Pricing({ owner }: { owner: boolean }) {
  const t = useTranslations("settings");
  const f = useFormat();
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
    onSuccess: () => (toast.success(t("pricing.updatedToast")), void qc.invalidateQueries({ queryKey: ["pricing"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pricing.title")}</CardTitle>
          <CardDescription>{t("pricing.description", { usd: f.money(data?.creditUsd ?? 0.01, "USD") })}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("pricing.model")}</TableHead>
                <TableHead className="text-right">{t("pricing.inputPer1k")}</TableHead>
                <TableHead className="text-right">{t("pricing.outputPer1k")}</TableHead>
                <TableHead className="text-right">{t("pricing.cacheReadPer1k")}</TableHead>
                <TableHead className="text-right">{t("pricing.cacheWritePer1k")}</TableHead>
                <TableHead className="text-right">{t("pricing.forecast")}</TableHead>
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
                        f.number(m[k], 4)
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">
                    {t("pricing.creditsShort", { value: f.number((tokIn / 1000) * m.inputPer1k + (tokOut / 1000) * m.outputPer1k + calls * 0.1, 2) })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {t("pricing.forecastPrefix")}
            <Input type="number" className="h-7 w-24" value={tokIn} onChange={(e) => setTokIn(Number(e.target.value))} /> {t("pricing.forecastInput")}
            <Input type="number" className="h-7 w-20" value={tokOut} onChange={(e) => setTokOut(Number(e.target.value))} /> {t("pricing.forecastOutput")}
            <Input type="number" className="h-7 w-16" value={calls} onChange={(e) => setCalls(Number(e.target.value))} /> {t("pricing.forecastCalls", { avg: f.number(0.1) })}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pricing.perToolCall")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          {data?.tools.map((tool) => (
            <div key={tool.name} className="flex justify-between rounded px-2 py-1 odd:bg-muted/40">
              <span>
                {tool.label}{" "}
                <span className={tool.class === "irreversible" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  ({tool.class === "irreversible" ? t("pricing.toolClass.irreversible") : tool.class === "reversible" ? t("pricing.toolClass.reversible") : tool.class})
                </span>
              </span>
              <span className="tabular-nums">{t("pricing.creditsShort", { value: f.credits(tool.credits) })}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Members({ owner, admin, meId }: { owner: boolean; admin: boolean; meId?: string }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["members"], queryFn: () => api.get<{ members: { userId: string; email: string; name: string; role: string }[] }>("/api/members") });
  const [f, setF] = useState({ email: "", name: "", role: "MEMBER" });
  const add = useMutation({
    mutationFn: () => api.post<{ tempPassword: string | null }>("/api/members", f),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["members"] });
      if (r.tempPassword) prompt(t("members.createdPrompt"), r.tempPassword);
      else toast.success(t("members.addedToast"));
      setF({ email: "", name: "", role: "MEMBER" });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const role = useMutation({ mutationFn: (v: { userId: string; role: string }) => api.patch("/api/members", v), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }), onError: (e) => toast.error((e as Error).message) });
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/api/members?userId=${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["members"] });
      toast.success(t("members.removedToast"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reset = useMutation({
    mutationFn: (userId: string) => api.post<{ tempPassword: string }>("/api/members/reset-password", { userId }),
    onSuccess: (r) => prompt(t("members.resetPrompt"), r.tempPassword),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("members.title")}</CardTitle>
        <CardDescription>{t("members.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.members.map((m) => (
          <div key={m.userId} className="flex items-center gap-2 text-sm">
            <span className="flex-1">
              {m.name} <span className="text-muted-foreground">{m.email}</span>
            </span>
            <select disabled={!owner} className="h-8 rounded-md border bg-background px-2 text-sm" value={m.role} onChange={(e) => role.mutate({ userId: m.userId, role: e.target.value })}>
              {["OWNER", "ADMIN", "MEMBER", "VIEWER"].map((r) => (
                <option key={r} value={r}>
                  {ts(`role.${r}`)}
                </option>
              ))}
            </select>
            {admin && m.userId !== meId && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2"
                  disabled={(m.role === "OWNER" && !owner) || reset.isPending}
                  onClick={() => confirm(t("members.resetConfirm", { email: m.email })) && reset.mutate(m.userId)}
                  aria-label={t("members.resetAria", { email: m.email })}
                  title={t("members.resetPassword")}
                >
                  <KeyRound className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-destructive hover:text-destructive"
                  disabled={(m.role === "OWNER" && !owner) || remove.isPending}
                  onClick={() => confirm(t("members.removeConfirm", { email: m.email })) && remove.mutate(m.userId)}
                  aria-label={t("members.removeAria", { email: m.email })}
                  title={t("members.removeFromWorkspace")}
                >
                  <UserMinus className="size-4" />
                </Button>
              </>
            )}
          </div>
        ))}
        {admin && (
        <div className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_1fr_120px_auto]">
          <Input placeholder={tc("email")} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Input placeholder={tc("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {["ADMIN", "MEMBER", "VIEWER", ...(owner ? ["OWNER"] : [])].map((r) => (
              <option key={r} value={r}>
                {ts(`role.${r}`)}
              </option>
            ))}
          </select>
          <Button onClick={() => add.mutate()} disabled={!f.email || !f.name}>
            {tc("add")}
          </Button>
        </div>
        )}
      </CardContent>
    </Card>
  );
}

function Audit() {
  const t = useTranslations("settings");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<{ entries: { id: string; actorLabel: string; action: string; targetType: string; targetId: string | null; details: Record<string, unknown>; createdAt: string }[] }>("/api/audit"),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("audit.title")}</CardTitle>
        <CardDescription>{t("audit.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {data?.entries.map((e) => (
          <details key={e.id} className="rounded border px-3 py-2 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{f.dateTime(e.createdAt)}</span>
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
  const t = useTranslations("settings");
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const { data: me } = useMe();
  const admin = me?.role === "OWNER" || me?.role === "ADMIN";
  const owner = me?.role === "OWNER";
  if (!data) return null;
  return (
    <div>
      <PageHeader title={t("title")} />
      <Tabs defaultValue="general">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">{t("tabs.general")}</TabsTrigger>
          {admin && <TabsTrigger value="email">{t("tabs.email")}</TabsTrigger>}
          {admin && <TabsTrigger value="notifications">{t("tabs.notifications")}</TabsTrigger>}
          {admin && <TabsTrigger value="integrations">{t("tabs.integrations")}</TabsTrigger>}
          {admin && <TabsTrigger value="repositories">{t("tabs.repositories")}</TabsTrigger>}
          <TabsTrigger value="departments">{t("tabs.departments")}</TabsTrigger>
          <TabsTrigger value="pricing">{t("tabs.pricing")}</TabsTrigger>
          <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
          {admin && <TabsTrigger value="audit">{t("tabs.audit")}</TabsTrigger>}
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
        <TabsContent value="departments" className="mt-4">
          <DepartmentsSettings admin={admin} />
        </TabsContent>
        <TabsContent value="repositories" className="mt-4">
          <RepositoriesSettings owner={owner} />
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
