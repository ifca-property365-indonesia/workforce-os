"use client";

import { RepositoriesSettings } from "@/components/settings/repositories";
import { WebhooksSettings } from "@/components/settings/webhooks";
import { ServersSettings } from "@/components/settings/servers";
import { ApiTokensSettings } from "@/components/settings/api-tokens";
import { SkillsSettings } from "@/components/settings/skills";
import { CompanyProfileSettings } from "@/components/settings/company-profile";
import { UsageBudgetSettings } from "@/components/settings/usage-budget";
import { EmailPolicySettings, SmtpPresetPicker, useSmtpUserHint } from "@/components/settings/email-policy";
import { mcpToolsQueryKey, type McpTool } from "@/components/employees/tool-permissions";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "@/lib/nav";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, KeyRound, Loader2, PlugZap, UserMinus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShareLinksSettings } from "@/components/settings/share-links";
import { ClaudeConnect } from "@/components/settings/claude-connect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { useMe } from "@/lib/hooks";
import { settingsTab } from "@/lib/settings-tabs";

interface Settings {
  workspace: { id: string; name: string; monthlyBudget: number; guardsEnabled: boolean; demoMode: boolean; killSwitch: boolean; notifyEmail: string | null; webhookConfigured: boolean; require2faAdmins: boolean; defaultLocale: "id" | "en" | null; timezone: string; approvalExpiryHours: number };
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
              <span className="text-success">{data.effective.source === "workspace" ? t("claude.inUseWorkspace") : t("claude.inUseFallback")}</span>
            ) : (
              <span className="text-destructive">{t("claude.inUseNone")}</span>
            )}
          </div>
        </div>
        {owner && <ClaudeConnect hasCredential={!!data.workspace} onConnected={done} />}
        {owner && <div className="font-medium">{t("claude.connect.orPaste")}</div>}
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
  const [expiry, setExpiry] = useState(s.workspace.approvalExpiryHours);
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
            <Label htmlFor="workspace-name">{tc("name")}</Label>
            <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-budget">{t("workspace.monthlyBudget")}</Label>
            <Input id="workspace-budget" type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
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
          <div className="flex flex-wrap items-end justify-between gap-4">
            <span>
              <label htmlFor="approval-expiry" className="block text-sm font-medium">
                {t("safety.approvalExpiry")}
              </label>
              <span className="block text-xs text-muted-foreground">{t("safety.approvalExpiryHint")}</span>
            </span>
            <span className="flex items-center gap-2">
              <Input id="approval-expiry" type="number" min={0} max={2160} className="w-24" value={expiry} disabled={!admin} onChange={(e) => setExpiry(Number(e.target.value))} />
              <Button size="sm" variant="outline" disabled={!admin || save.isPending || expiry === s.workspace.approvalExpiryHours} onClick={() => save.mutate({ approvalExpiryHours: expiry })}>
                {tc("save")}
              </Button>
            </span>
          </div>
        </CardContent>
      </Card>
      {admin && <ClaudeCredential owner={owner} />}
      {admin && <UsageBudgetSettings />}
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
  const userHint = useSmtpUserHint(f);
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SMTP</CardTitle>
          <CardDescription>{t("email.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <SmtpPresetPicker value={f} onPick={(p) => setF({ ...f, ...p })} />
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host">{t("email.host")}</Label>
            {/* i18n-ignore: example host name */}
            <Input id="smtp-host" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.gmail.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port">{t("email.port")}</Label>
              <Input id="smtp-port" type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <Switch checked={f.secure} onCheckedChange={(v) => setF({ ...f, secure: v })} /> {t("email.tls")}
            </label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-user">{t("email.user")}</Label>
            <Input id="smtp-user" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} autoComplete="off" placeholder={userHint} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-password">
              {tc("password")} {data?.smtp?.passwordSet && <span className="text-xs text-muted-foreground">{t("email.passwordSet")}</span>}
            </Label>
            <Input id="smtp-password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="smtp-from">{t("email.fromAddress")}</Label>
            {/* i18n-ignore: example sender address */}
            <Input id="smtp-from" value={f.fromAddress} onChange={(e) => setF({ ...f, fromAddress: e.target.value })} placeholder='"Acme Studio" <hello@acme.com>' />
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button onClick={() => save.mutate()} disabled={!f.host || !f.fromAddress}>
              {tc("save")}
            </Button>
            <Input className="max-w-60" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("email.testRecipient")} aria-label={t("email.testRecipient")} />
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !to}>
              {test.isPending ? t("email.sending") : t("email.sendTest")}
            </Button>
          </div>
        </CardContent>
      </Card>
      <EmailPolicySettings />
    </div>
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
            <Label htmlFor="notify-email">{t("notifications.notifyEmail")}</Label>
            <Input id="notify-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby="notify-email-help" />
          </div>
          <Button onClick={() => save.mutate({ notifyEmail: email })}>{tc("save")}</Button>
          <p id="notify-email-help" className="basis-full text-xs text-muted-foreground">
            {t("notifications.notifyEmailHelp")}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="notify-webhook">
              {t("notifications.webhookUrl")} {s.workspace.webhookConfigured && <span className="text-xs text-success">{t("notifications.configured")}</span>}
            </Label>
            <Input id="notify-webhook" value={hook} onChange={(e) => setHook(e.target.value)} placeholder={t("notifications.webhookPlaceholder")} />
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

interface McpServerItem {
  id: string;
  name: string;
  url: string;
  tokenSet: boolean;
  auth: "token" | "oauth";
  /** an OAuth server whose sign-in has to be redone (refused refresh, or expired with nothing to refresh it) */
  needsReconnect: boolean;
  /** a slot an import left unconfigured: never contacted until an Owner saves it with its token */
  disabled: boolean;
}

/** A started OAuth sign-in, shown to the Owner before the browser leaves for the authorization server. */
interface McpOAuthStartInfo {
  authorizeUrl: string;
  authorizationServerHost: string;
  scopes: string[];
  sameSite: boolean;
}

/** OAuth sign-in to an MCP server, step 1: the server names its authorization page; nothing is opened yet. */
function startMcpOAuth(name: string, url: string) {
  return api.post<McpOAuthStartInfo>("/api/settings/mcp/oauth/start", { name, url });
}

/**
 * Step 2: the Owner sees where they are about to sign in (the authorization server's host, the scopes asked for),
 * with a warning when that host is on another site than the MCP server, and only then goes there.
 */
function McpOAuthConfirm({ start, mcpUrl, onClose }: { start: McpOAuthStartInfo | null; mcpUrl: string; onClose: () => void }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  let mcpHost = "";
  try {
    mcpHost = new URL(mcpUrl).host;
  } catch {
    // shown as typed below
  }
  return (
    <Dialog open={!!start} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("integrations.oauthConfirmTitle")}</DialogTitle>
          <DialogDescription>{t("integrations.oauthConfirmDescription", { host: mcpHost || mcpUrl })}</DialogDescription>
        </DialogHeader>
        {start && (
          <div className="space-y-3 text-sm">
            <div role="group" aria-labelledby="mcp-oauth-server-label" className="space-y-1">
              <Label id="mcp-oauth-server-label">{t("integrations.oauthServer")}</Label>
              <code className="block break-all rounded-md border bg-muted px-2 py-1.5 text-xs">{start.authorizationServerHost}</code>
            </div>
            <div role="group" aria-labelledby="mcp-oauth-scopes-label" className="space-y-1">
              <Label id="mcp-oauth-scopes-label">{t("integrations.oauthScopes")}</Label>
              {start.scopes.length ? (
                <ul className="flex flex-wrap gap-1">
                  {start.scopes.map((s) => (
                    <li key={s}>
                      <code className="rounded border px-1.5 py-0.5 text-xs">{s}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("integrations.oauthScopesDefault")}</p>
              )}
            </div>
            {!start.sameSite && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription>{t("integrations.oauthOtherSite", { as: start.authorizationServerHost, mcp: mcpHost || mcpUrl })}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant={start?.sameSite === false ? "destructive" : "default"} onClick={() => start && window.location.assign(start.authorizeUrl)}>
            {t("integrations.oauthContinue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One connected MCP server, with a live "Test connection" that lists its tools through the server. */
function McpServerRow({
  server,
  onRemove,
  onOAuth,
  onSetUp,
}: {
  server: McpServerItem;
  onRemove: () => void;
  onOAuth: (start: McpOAuthStartInfo, url: string) => void;
  onSetUp: () => void;
}) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data: me } = useMe();
  const test = useMutation({
    mutationFn: () => api.get<{ tools: McpTool[] }>(`/api/settings/mcp/${encodeURIComponent(server.name)}/tools`),
    // the employee editor's per-tool list reads the same cache entry
    onSuccess: (r) => qc.setQueryData(mcpToolsQueryKey(me?.workspace.id, server.name), r),
  });
  const reconnect = useMutation({
    mutationFn: () => startMcpOAuth(server.name, server.url),
    onSuccess: (r) => onOAuth(r, server.url),
    onError: (e) => toast.error((e as Error).message),
  });
  const oauth = server.auth === "oauth";
  return (
    <div className="rounded-md border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium">{server.name}</code>
        {oauth && <span className="rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("integrations.oauthBadge")}</span>}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{server.url}</span>
        {server.disabled && <span className="text-xs text-warning">{t("integrations.importedDisabled")}</span>}
        {oauth && server.needsReconnect && <span className="text-xs text-warning">{t("integrations.needsReconnect")}</span>}
        {!oauth && server.tokenSet && <span className="text-xs text-success">{t("integrations.tokenSet")}</span>}
        {server.disabled && (
          <Button size="sm" variant="outline" className="gap-1" onClick={onSetUp}>
            <KeyRound className="size-3.5" />
            {t("integrations.setUp")}
          </Button>
        )}
        {oauth && server.needsReconnect && (
          <Button size="sm" variant="outline" className="gap-1" onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
            {reconnect.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
            {t("integrations.reconnect")}
          </Button>
        )}
        <Button size="sm" variant="outline" className="gap-1" onClick={() => test.mutate()} disabled={test.isPending || server.disabled}>
          {test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          {t("integrations.test")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {tc("remove")}
        </Button>
      </div>
      {test.isSuccess && (
        <div className="mt-2 text-xs text-success">
          {t("integrations.testOk", { count: test.data.tools.length, reversible: test.data.tools.filter((x) => x.class === "reversible").length })}
        </div>
      )}
      {test.isError && <div className="mt-2 break-words text-xs text-destructive">{(test.error as Error).message}</div>}
    </div>
  );
}

/** What the OAuth callback reported (?mcp=<outcome>), once: a toast, then the parameter is dropped from the URL. */
const MCP_OAUTH_OUTCOMES = ["connected", "invalid_state", "denied", "failed", "forbidden"] as const;
function useMcpOAuthOutcome() {
  const t = useTranslations("settings");
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const outcome = params.get("mcp");
  useEffect(() => {
    if (!outcome) return;
    const known = (MCP_OAUTH_OUTCOMES as readonly string[]).includes(outcome) ? (outcome as (typeof MCP_OAUTH_OUTCOMES)[number]) : "failed";
    if (known === "connected") toast.success(t("integrations.oauthResult.connected"));
    else toast.error(t(`integrations.oauthResult.${known}`));
    const rest = new URLSearchParams(params.toString());
    rest.delete("mcp");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [outcome, params, pathname, router, t]);
}

function Integrations() {
  const t = useTranslations("settings");
  const qc = useQueryClient();
  useMcpOAuthOutcome();
  const { data } = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers: McpServerItem[] }>("/api/settings/mcp") });
  const [f, setF] = useState({ name: "", url: "", token: "" });
  const add = useMutation({
    mutationFn: () => api.post("/api/settings/mcp", { ...f, token: f.token || undefined }),
    onSuccess: () => (setF({ name: "", url: "", token: "" }), void qc.invalidateQueries({ queryKey: ["mcp"] })),
    onError: (e) => toast.error((e as Error).message),
  });
  const [oauthStart, setOAuthStart] = useState<{ start: McpOAuthStartInfo; url: string } | null>(null);
  const oauth = useMutation({
    mutationFn: () => startMcpOAuth(f.name, f.url),
    onSuccess: (r) => setOAuthStart({ start: r, url: f.url }),
    onError: (e) => toast.error((e as Error).message),
  });
  const { data: me } = useMe();
  const del = useMutation({
    mutationFn: (name: string) => api.del(`/api/settings/mcp?name=${encodeURIComponent(name)}`),
    onSuccess: (_r, name) => {
      // its cached tool list is stale now (a server added again under the same name may expose other tools)
      void qc.invalidateQueries({ queryKey: mcpToolsQueryKey(me?.workspace.id, name) });
      return qc.invalidateQueries({ queryKey: ["mcp"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("integrations.title")}</CardTitle>
        <CardDescription>{t.rich("integrations.description", { grant: "mcp:<name>", code: (c) => <code>{c}</code> })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.servers.map((s) => (
          <McpServerRow
            key={s.id}
            server={s}
            onRemove={() => del.mutate(s.name)}
            onOAuth={(start, url) => setOAuthStart({ start, url })}
            // an imported slot: its name and URL go into the form, where the Owner checks the URL and adds the token
            onSetUp={() => setF({ name: s.name, url: s.url, token: "" })}
          />
        ))}
        <McpOAuthConfirm start={oauthStart?.start ?? null} mcpUrl={oauthStart?.url ?? ""} onClose={() => setOAuthStart(null)} />
        <div className="grid gap-2 sm:grid-cols-[140px_1fr_1fr_auto_auto]">
          <Input placeholder={t("integrations.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          {/* i18n-ignore: example URL */}
          <Input placeholder="https://…/mcp" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          <Input type="password" placeholder={t("integrations.tokenPlaceholder")} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
          <Button onClick={() => add.mutate()} disabled={!f.name || !f.url}>
            {t("integrations.connect")}
          </Button>
          <Button variant="outline" className="gap-1" onClick={() => oauth.mutate()} disabled={!f.name || !f.url || !!f.token || oauth.isPending}>
            {oauth.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
            {t("integrations.oauthConnect")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("integrations.oauthHint")}</p>
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
  // ?tab=<tab> opens that tab (the MCP OAuth callback comes back to integrations); read through @/lib/nav so it is
  // this window's address on the desktop, not the browser's
  const requestedTab = useSearchParams().get("tab");
  // the role decides which tabs exist: wait for it, so ?tab= can only open a tab this person can see
  if (!data || !me) return null;
  const initialTab = settingsTab(requestedTab, admin);
  return (
    <div>
      <PageHeader title={t("title")} />
      <Tabs key={initialTab} defaultValue={initialTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">{t("tabs.general")}</TabsTrigger>
          {admin && <TabsTrigger value="email">{t("tabs.email")}</TabsTrigger>}
          {admin && <TabsTrigger value="notifications">{t("tabs.notifications")}</TabsTrigger>}
          {admin && <TabsTrigger value="integrations">{t("tabs.integrations")}</TabsTrigger>}
          {admin && <TabsTrigger value="repositories">{t("tabs.repositories")}</TabsTrigger>}
          <TabsTrigger value="servers">{t("tabs.servers")}</TabsTrigger>
          <TabsTrigger value="skills">{t("tabs.skills")}</TabsTrigger>
          <TabsTrigger value="pricing">{t("tabs.pricing")}</TabsTrigger>
          <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
          {admin && <TabsTrigger value="webhooks">{t("tabs.webhooks")}</TabsTrigger>}
          <TabsTrigger value="api">{t("tabs.apiTokens")}</TabsTrigger>
          {admin && <TabsTrigger value="audit">{t("tabs.audit")}</TabsTrigger>}
        </TabsList>
        <TabsContent value="general" className="mt-4">
          <General s={data} owner={owner} admin={admin} />
          <CompanyProfileSettings admin={admin} />
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
        <TabsContent value="skills" className="mt-4">
          <SkillsSettings admin={admin} />
        </TabsContent>
        <TabsContent value="repositories" className="mt-4">
          <RepositoriesSettings owner={owner} />
        </TabsContent>
        <TabsContent value="servers" className="mt-4">
          <ServersSettings owner={owner} admin={admin} />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <Pricing owner={owner} />
        </TabsContent>
        <TabsContent value="members" className="mt-4">
          <Members owner={owner} admin={admin} meId={me?.user.id} />
          {owner && (
            <div className="mt-6">
              <ShareLinksSettings />
            </div>
          )}
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <WebhooksSettings owner={owner} admin={admin} />
        </TabsContent>
        <TabsContent value="api" className="mt-4">
          <ApiTokensSettings admin={admin} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <Audit />
        </TabsContent>
      </Tabs>
    </div>
  );
}
