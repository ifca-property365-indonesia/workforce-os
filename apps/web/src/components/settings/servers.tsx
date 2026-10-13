"use client";

import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Copy, Download, Loader2, ShieldCheck } from "lucide-react";
import type { ServerInfo, ServerRole, ServerStatus } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { signVars, type SignColor, type SignState } from "@/lib/sign";
import { setupBundle } from "./servers-bundle";
import { useFormat } from "@/lib/use-format";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  role: ServerRole;
  baseDomain: string;
  hostKeyAlgo: string | null;
  hostKeyFingerprint: string | null;
  status: ServerStatus;
  statusMessage: string | null;
  maxRunningApps: number;
  info: ServerInfo | null;
  lastCheckedAt: string | null;
}

interface SshKey {
  publicKey: string;
  fingerprint: string;
  prepareCommand: string;
}

/** ["servers"] is invalidated by the server.updated event (lib/events.tsx); everything here sits under it */
export const serversQueryKey = ["servers"] as const;

// i18n-ignore: a shell command, the same in every language
const FINGERPRINT_COMMAND = "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub";

const SIGN: Record<ServerStatus, { color: SignColor; state: SignState }> = {
  ready: { color: "hijau", state: "lit" },
  pending: { color: "kuning", state: "off" },
  error: { color: "merah", state: "fault" },
};
const TONE: Record<ServerStatus, string> = {
  ready: "border-success/40 bg-success/10 text-success",
  pending: "border-warning/40 bg-warning/10 text-warning",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    // clipboard blocked (http, permissions): the text stays selectable on the page
  }
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/x-shellscript" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Settings → Servers. Everyone reads; Admins check and see the key; Owners add, verify, edit and remove. */
export function ServersSettings({ owner, admin }: { owner: boolean; admin: boolean }) {
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const errorText = useErrorText();
  const list = useQuery({ queryKey: serversQueryKey, queryFn: () => api.get<{ servers: Server[]; allowPrivate: boolean }>("/api/servers") });
  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; server: Server } | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: serversQueryKey });
  const onError = (e: unknown) => toast.error((e as Error).message);

  const check = useMutation({
    mutationFn: (id: string) => api.post<{ server: Server }>(`/api/servers/${id}/check`),
    onSuccess: ({ server }) => {
      refresh();
      if (server.status === "ready") toast.success(t("checkedReady", { name: server.name }));
      else toast.error(errorText(server));
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (s: Server) => withStepUp(() => api.del<{ ok: true }>(`/api/servers/${s.id}`)),
    onSuccess: (r) => {
      if (!r) return;
      toast.success(t("deleted"));
      refresh();
    },
    onError,
  });

  const servers = list.data?.servers;
  const setupServer = servers?.find((s) => s.id === setupId) ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
          {!owner && <CardDescription>{t("ownerOnly")}</CardDescription>}
          {owner && list.data?.allowPrivate && <CardDescription>{t("privateAllowed")}</CardDescription>}
        </div>
        {owner && (
          <Button size="sm" onClick={() => setForm({ mode: "add" })}>
            {t("add")}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {list.isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={tc("loading")} />}
        {servers && !servers.length && (
          <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            <p>{owner ? t("empty") : t("emptyReadOnly")}</p>
            {owner && (
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setForm({ mode: "add" })}>
                {t("add")}
              </Button>
            )}
          </div>
        )}
        <ul className="space-y-4">
          {servers?.map((s) => (
            <ServerItem
              key={s.id}
              server={s}
              owner={owner}
              admin={admin}
              checking={check.isPending && check.variables === s.id}
              onCheck={() => check.mutate(s.id)}
              onSetup={() => setSetupId(s.id)}
              onEdit={() => setForm({ mode: "edit", server: s })}
              onDelete={() => confirm(t("deleteConfirm", { name: s.name })) && remove.mutate(s)}
            />
          ))}
        </ul>
      </CardContent>

      {form && (
        <ServerFormDialog
          key={form.mode === "edit" ? form.server.id : "add"}
          server={form.mode === "edit" ? form.server : null}
          onClose={() => setForm(null)}
          onSaved={(s, added) => {
            setForm(null);
            // show the new server at once, so its setup guide can open before the refetch lands
            if (added) qc.setQueryData<{ servers: Server[]; allowPrivate: boolean }>(serversQueryKey, (old) => (old ? { ...old, servers: [s, ...old.servers] } : old));
            refresh();
            if (added) {
              toast.success(t("added"));
              setSetupId(s.id);
            } else toast.success(t("saved"));
          }}
        />
      )}

      <Sheet open={!!setupServer} onOpenChange={(o) => !o && setSetupId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {setupServer && <SetupGuide key={setupServer.id} server={setupServer} owner={owner} checking={check.isPending} onCheck={() => check.mutate(setupServer.id)} />}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

/** The friendly text for a server's error code (both languages), falling back to "unknown". */
function useErrorText() {
  const t = useTranslations("servers");
  return (s: Pick<Server, "statusMessage" | "baseDomain">): string => {
    const code = s.statusMessage ?? "unknown";
    return t.has(`error.${code}`) ? t(`error.${code}`, { domain: s.baseDomain }) : t("error.unknown");
  };
}

function StatusBadge({ status }: { status: ServerStatus }) {
  const t = useTranslations("servers");
  return (
    <Badge variant="outline" className={TONE[status]}>
      {t(`status.${status}`)}
    </Badge>
  );
}

function ServerItem(props: {
  server: Server;
  owner: boolean;
  admin: boolean;
  checking: boolean;
  onCheck: () => void;
  onSetup: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { server: s, owner, admin } = props;
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const f = useFormat();
  const errorText = useErrorText();
  const sign = SIGN[s.status];
  return (
    <li className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="sign font-display max-w-full truncate rounded-md px-2.5 pt-1.5 pb-1 text-lg" style={signVars(sign.color)} data-state={sign.state}>
          {s.name}
        </span>
        <StatusBadge status={s.status} />
        <Badge variant="secondary">{t(`role.${s.role}`)}</Badge>
        <div className="flex w-full flex-wrap gap-1 sm:ml-auto sm:w-auto">
          {owner && s.status !== "ready" && (
            <Button size="sm" onClick={props.onSetup}>
              {t("actions.setup")}
            </Button>
          )}
          {admin && (s.status === "ready" || !owner) && (
            <Button size="sm" variant="outline" onClick={props.onSetup}>
              {t("actions.guide")}
            </Button>
          )}
          {admin && s.hostKeyFingerprint && (
            <Button size="sm" variant="outline" disabled={props.checking} onClick={props.onCheck}>
              {props.checking && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {t("actions.check")}
            </Button>
          )}
          {owner && (
            <>
              <Button size="sm" variant="ghost" onClick={props.onEdit}>
                {tc("edit")}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={props.onDelete}>
                {tc("delete")}
              </Button>
            </>
          )}
        </div>
      </div>

      {s.status === "error" && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{errorText(s)}</p>}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label={t("card.address")}>
          <code className="text-xs break-all">
            {s.username}@{s.host}:{s.port}
          </code>
        </Fact>
        <Fact label={t("card.domain")}>
          <code className="text-xs break-all">*.{s.baseDomain}</code>
        </Fact>
        <Fact label={t("card.fingerprint")}>
          {s.hostKeyFingerprint ? <code className="text-xs break-all">{s.hostKeyFingerprint}</code> : <span className="text-muted-foreground">{t("card.notPinned")}</span>}
        </Fact>
        <Fact label={t("card.lastCheck")}>{s.lastCheckedAt ? <span title={f.dateTime(s.lastCheckedAt)}>{f.ago(s.lastCheckedAt)}</span> : <span className="text-muted-foreground">{t("card.neverChecked")}</span>}</Fact>
        <Fact label={t("card.limit")}>{t("card.limitValue", { count: s.maxRunningApps })}</Fact>
      </dl>

      {s.info && <InfoStrip info={s.info} />}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** What the last probe reported, as a row of readouts. */
function InfoStrip({ info }: { info: ServerInfo }) {
  const t = useTranslations("servers");
  const f = useFormat();
  const gb = (mb: number) => t("info.gb", { value: f.number(mb / 1024, 1) });
  const cells = [
    { key: "node", label: t("info.node"), value: info.node || "—" },
    { key: "pnpm", label: t("info.pnpm"), value: info.pnpm || "—" },
    { key: "helper", label: t("info.helper"), value: t("info.helperValue", { version: info.helperVersion }) },
    { key: "disk", label: t("info.disk"), value: gb(info.diskFreeMb) },
    { key: "memory", label: t("info.memory"), value: t("info.memoryValue", { free: gb(info.memAvailableMb), total: gb(info.memTotalMb) }) },
    { key: "postgres", label: t("info.postgres"), value: info.postgresPort ? t("info.postgresValue", { port: info.postgresPort }) : t("info.postgresMissing") },
  ];
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <div key={c.key} className="min-w-0 border-t border-l p-2.5 [&:nth-child(-n+2)]:border-t-0 [&:nth-child(odd)]:border-l-0 sm:[&:nth-child(-n+3)]:border-t-0 sm:[&:nth-child(odd)]:border-l sm:[&:nth-child(3n+1)]:border-l-0 lg:[&:nth-child(-n+6)]:border-t-0 lg:[&:nth-child(3n+1)]:border-l lg:[&:first-child]:border-l-0">
          <div className="truncate text-xs text-muted-foreground">{c.label}</div>
          <div className="text-sm font-semibold break-words tabular-nums">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

const EMPTY_FORM = { name: "", host: "", port: "22", username: "wfos-apps", baseDomain: "", maxRunningApps: "3" };

function ServerFormDialog({ server, onClose, onSaved }: { server: Server | null; onClose: () => void; onSaved: (s: Server, added: boolean) => void }) {
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const [f, setF] = useState(
    server
      ? { name: server.name, host: server.host, port: String(server.port), username: server.username, baseDomain: server.baseDomain, maxRunningApps: String(server.maxRunningApps) }
      : EMPTY_FORM,
  );
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const moved = !!server && (f.host.trim() !== server.host || Number(f.port) !== server.port || f.username.trim() !== server.username || f.baseDomain.trim().toLowerCase() !== server.baseDomain);
  const save = useMutation({
    mutationFn: () => {
      const b = { name: f.name.trim(), host: f.host.trim(), port: Number(f.port), username: f.username.trim(), baseDomain: f.baseDomain.trim().toLowerCase(), maxRunningApps: Number(f.maxRunningApps) };
      return server ? api.patch<{ server: Server }>(`/api/servers/${server.id}`, b) : api.post<{ server: Server }>("/api/servers", { ...b, role: "dev" });
    },
    onSuccess: (r) => onSaved(r.server, !server),
    onError: (e) => toast.error((e as Error).message),
  });
  const valid = f.name.trim() && f.host.trim() && f.baseDomain.trim() && Number(f.port) > 0 && Number(f.maxRunningApps) > 0 && f.username.trim();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? t("editTitle", { name: server.name }) : t("addTitle")}</DialogTitle>
          {!server && <DialogDescription>{t("addDescription")}</DialogDescription>}
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="srv-name">{t("fields.name")}</Label>
            <Input id="srv-name" value={f.name} maxLength={60} placeholder={t("fields.namePlaceholder")} onChange={set("name")} />
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="srv-host">{t("fields.host")}</Label>
              <Input id="srv-host" value={f.host} maxLength={253} autoCapitalize="none" spellCheck={false} placeholder="203.0.113.10" onChange={set("host")} aria-describedby="srv-host-help" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="srv-port">{t("fields.port")}</Label>
              <Input id="srv-port" type="number" inputMode="numeric" min={1} max={65535} value={f.port} onChange={set("port")} />
            </div>
          </div>
          <p id="srv-host-help" className="-mt-1 text-xs text-muted-foreground">
            {t("fields.hostHelp")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="srv-domain">{t("fields.baseDomain")}</Label>
            <Input
              id="srv-domain"
              value={f.baseDomain}
              maxLength={200}
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("fields.baseDomainPlaceholder")}
              onChange={set("baseDomain")}
              aria-describedby="srv-domain-help"
            />
            <p id="srv-domain-help" className="text-xs text-muted-foreground">
              {t("fields.baseDomainHelp")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="srv-user">{t("fields.username")}</Label>
              <Input id="srv-user" value={f.username} maxLength={32} autoCapitalize="none" spellCheck={false} onChange={set("username")} aria-describedby="srv-user-help" />
              <p id="srv-user-help" className="text-xs text-muted-foreground">
                {t("fields.usernameHelp")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="srv-max">{t("fields.maxRunningApps")}</Label>
              <Input id="srv-max" type="number" inputMode="numeric" min={1} max={50} value={f.maxRunningApps} onChange={set("maxRunningApps")} aria-describedby="srv-max-help" />
              <p id="srv-max-help" className="text-xs text-muted-foreground">
                {t("fields.maxRunningAppsHelp")}
              </p>
            </div>
          </div>
          {moved && server?.hostKeyFingerprint && <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{t("resetWarning")}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button disabled={!valid || save.isPending}>{server ? tc("save") : t("add")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A numbered step: the number is a small sign, lit once the step is done or current. */
function Step({ n, title, state, children }: { n: number; title: string; state: "done" | "current" | "todo"; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid grid-cols-[2rem_1fr] gap-x-3">
      <span
        className="sign font-display grid size-8 place-items-center rounded-md text-lg"
        style={signVars(state === "done" ? "hijau" : "kuning")}
        data-state={state === "todo" ? "off" : "lit"}
        aria-hidden
      >
        {state === "done" ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 space-y-3 pb-6">
        <h3 id={id} className="pt-1 text-sm font-semibold">
          {title}
        </h3>
        {children}
      </div>
    </section>
  );
}

function CodeBlock({ code, label, copyText }: { code: string; label: string; copyText?: string }) {
  const tc = useTranslations("common");
  return (
    <div className="relative min-w-0">
      <pre aria-label={label} className="max-h-48 overflow-auto rounded-md bg-muted p-2.5 pr-11 font-mono text-xs break-all whitespace-pre-wrap">
        {code}
      </pre>
      <Button type="button" size="icon" variant="ghost" className="absolute top-1 right-1 size-8" aria-label={tc("copy")} onClick={() => void copy(copyText ?? code, tc("copied"))}>
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

/** The Owner's guided setup: prepare the server, compare the fingerprint, confirm (step-up), result. */
function SetupGuide({ server: s, owner, checking, onCheck }: { server: Server; owner: boolean; checking: boolean; onCheck: () => void }) {
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const errorText = useErrorText();
  const keyQ = useQuery({ queryKey: [...serversQueryKey, "ssh-key", s.id], queryFn: () => api.get<SshKey>(`/api/servers/ssh-key?serverId=${s.id}`) });
  const scriptsQ = useQuery({
    queryKey: [...serversQueryKey, "prepare-script"],
    queryFn: () => api.get<{ files: { name: string; content: string }[] }>("/api/servers/prepare-script"),
    retry: false,
    staleTime: Infinity,
  });
  const [scanned, setScanned] = useState<{ algo: string; fingerprint: string } | null>(null);
  const [matched, setMatched] = useState(false);
  const [verified, setVerified] = useState(false);
  const matchId = useId();

  const scan = useMutation({
    mutationFn: () => api.post<{ algo: string; fingerprint: string }>(`/api/servers/${s.id}/scan`),
    onSuccess: (r) => {
      setScanned(r);
      setMatched(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const verify = useMutation({
    mutationFn: (fingerprint: string) => withStepUp(() => api.post<{ server: Server }>(`/api/servers/${s.id}/verify`, { fingerprint })),
    onSuccess: (r) => {
      if (!r) return;
      setVerified(true);
      void qc.invalidateQueries({ queryKey: serversQueryKey });
      if (r.server.status === "ready") toast.success(t("verifiedReady", { name: r.server.name }));
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const ready = s.status === "ready";
  const showResult = verified || !!s.hostKeyFingerprint;
  const bundle = keyQ.data && scriptsQ.data ? setupBundle(scriptsQ.data.files, keyQ.data.prepareCommand) : null;
  const user = s.username;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-display text-2xl">{t("setup.title", { name: s.name })}</SheetTitle>
        <SheetDescription>{t("setup.description")}</SheetDescription>
      </SheetHeader>
      <div className="px-4 pb-6">
        <Step n={1} title={t("setup.step1.title")} state={scanned || showResult ? "done" : "current"}>
          <p className="text-sm">{t("setup.step1.intro")}</p>
          <div className="text-sm">
            <p className="text-muted-foreground">{t("setup.step1.installs")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>{t("setup.step1.itemUser", { user })}</li>
              <li>{t("setup.step1.itemWeb")}</li>
              <li>{t("setup.step1.itemNode")}</li>
              <li>{t("setup.step1.itemPostgres")}</li>
              <li>{t("setup.step1.itemHelper", { user })}</li>
            </ul>
          </div>
          <p className="flex gap-2 rounded-md border border-success/30 bg-success/5 p-2.5 text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>{t("setup.step1.noPassword", { user })}</span>
          </p>
          <p className="text-xs text-muted-foreground">{t("setup.step1.requirements")}</p>

          {(keyQ.isLoading || scriptsQ.isLoading) && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={tc("loading")} />}
          {keyQ.error && <p className="text-sm text-destructive">{(keyQ.error as Error).message}</p>}
          {scriptsQ.error && <p className="text-sm text-destructive">{t("setup.step1.scriptsMissing")}</p>}

          {bundle && (
            <div className="space-y-1.5">
              <h4 className="text-sm font-semibold">{t("setup.step1.optionA")}</h4>
              <p className="text-xs text-muted-foreground">{t("setup.step1.optionAHelp")}</p>
              <Button type="button" size="sm" onClick={() => void copy(bundle, tc("copied"))}>
                <Copy className="size-3.5" aria-hidden />
                {t("setup.step1.copyAll")}
              </Button>
            </div>
          )}
          {keyQ.data && (
            <div className="space-y-1.5">
              {scriptsQ.data && <h4 className="text-sm font-semibold">{t("setup.step1.optionB")}</h4>}
              <p className="text-xs text-muted-foreground">{t("setup.step1.optionBHelp")}</p>
              {scriptsQ.data && (
                <div className="flex flex-wrap gap-2">
                  {scriptsQ.data.files.map((file) => (
                    <Button key={file.name} type="button" size="sm" variant="outline" onClick={() => download(file.name, file.content)}>
                      <Download className="size-3.5" aria-hidden />
                      {t("setup.step1.download", { file: file.name })}
                    </Button>
                  ))}
                </div>
              )}
              <CodeBlock code={keyQ.data.prepareCommand} label={t("setup.step1.optionB")} />
            </div>
          )}
          {keyQ.data && (
            <div className="space-y-1.5">
              <h4 className="text-sm font-semibold">{t("setup.step1.publicKey")}</h4>
              <CodeBlock code={keyQ.data.publicKey} label={t("setup.step1.publicKey")} />
              <p className="text-xs text-muted-foreground">{t("setup.step1.publicKeyHelp", { user })}</p>
            </div>
          )}
          <p className="text-sm">{t("setup.step1.done")}</p>
        </Step>

        {!owner ? (
          <p className="rounded-md border p-3 text-sm text-muted-foreground">{t("setup.ownerOnlySteps")}</p>
        ) : (
          <>
            <Step n={2} title={t("setup.step2.title")} state={matched || showResult ? "done" : scanned ? "current" : "todo"}>
              <p className="text-sm">{t("setup.step2.intro")}</p>
              <Button type="button" size="sm" variant={scanned ? "outline" : "default"} disabled={scan.isPending} onClick={() => scan.mutate()}>
                {scan.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {scanned ? t("setup.step2.rescan") : t("setup.step2.scan")}
              </Button>
              {scanned && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">{t("setup.step2.found")}</p>
                    <p className="rounded-md border-2 border-dashed p-3 font-mono text-sm font-semibold break-all">{scanned.fingerprint}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm">{t("setup.step2.compare")}</p>
                    <CodeBlock code={FINGERPRINT_COMMAND} label={t("setup.step2.compare")} />
                  </div>
                  <div className="flex items-start gap-2">
                    <Checkbox id={matchId} checked={matched} onCheckedChange={(v) => setMatched(v === true)} className="mt-0.5" />
                    <Label htmlFor={matchId} className="text-sm leading-snug font-medium">
                      {t("setup.step2.match")}
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("setup.step2.mismatch")}</p>
                </div>
              )}
            </Step>

            <Step n={3} title={t("setup.step3.title")} state={showResult && !scanned ? "done" : matched ? "current" : "todo"}>
              <p className="text-sm">{t("setup.step3.intro")}</p>
              <Button type="button" size="sm" disabled={!scanned || !matched || verify.isPending} onClick={() => scanned && verify.mutate(scanned.fingerprint)}>
                {verify.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
                {t("setup.step3.verify")}
              </Button>
              {(!scanned || !matched) && <p className="text-xs text-muted-foreground">{t("setup.step3.needsMatch")}</p>}
            </Step>

            <Step n={4} title={t("setup.step4.title")} state={ready ? "done" : showResult ? "current" : "todo"}>
              {!showResult && <p className="text-sm text-muted-foreground">{t("setup.step4.pending")}</p>}
              {showResult && ready && (
                <p className="flex gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  <span>{t("setup.step4.ready", { name: s.name })}</span>
                </p>
              )}
              {showResult && !ready && s.status === "error" && (
                <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <p>{t("setup.step4.error")}</p>
                  <p className="font-medium text-destructive">{errorText(s)}</p>
                  <p className="text-muted-foreground">{t("setup.step4.retry")}</p>
                  {s.hostKeyFingerprint && (
                    <Button type="button" size="sm" variant="outline" disabled={checking} onClick={onCheck}>
                      {checking && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                      {t("actions.check")}
                    </Button>
                  )}
                </div>
              )}
              {s.info && showResult && <InfoStrip info={s.info} />}
            </Step>
          </>
        )}
      </div>
    </>
  );
}
