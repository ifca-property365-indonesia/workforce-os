"use client";

import { useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Construction, DatabaseBackup, Globe, KeyRound, Plus, Radio, Repeat, Trash2, X, Zap } from "lucide-react";
import { APP_LIVE_GRACE_SECONDS, customDomainSchema, type AppAccessMode, type AppDTO, type AppEnvironmentDTO, type ReleaseDTO, type ReleaseWindow } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { ReleaseDbPlan } from "@/lib/app-previews";
import { sameReleaseWindow } from "@/lib/release-window";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { useServers } from "./new-app-dialog";
import { ReleaseWindowFields, ReleaseWindowNote, releaseWindowState, useNow } from "./release-window";
import { CommitChip, EnvPlate, invalidateApp, selectClass } from "./shared";

/** at most this many names redirect to the live domain (the helper refuses more) */
const MAX_ALIASES = 3;

type DomainProblem = "invalid" | "preview" | "duplicate" | null;

/** what is wrong with one name before the API is asked (the API checks the same, and global uniqueness) */
function domainProblem(name: string, others: string[], previewBases: string[]): DomainProblem {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (!customDomainSchema.safeParse(n).success) return "invalid";
  if (previewBases.some((b) => n === b || n.endsWith(`.${b}`))) return "preview";
  if (others.includes(n)) return "duplicate";
  return null;
}

/** the names part of the setup and edit dialogs: the domain, then up to three that redirect to it (www. suggested) */
function DomainFields({
  domain,
  aliases,
  onDomain,
  onAliases,
  previewBases,
}: {
  domain: string;
  aliases: string[];
  onDomain: (v: string) => void;
  onAliases: (v: string[]) => void;
  previewBases: string[];
}) {
  const t = useTranslations("apps");
  const uid = useId();
  const d = domain.trim().toLowerCase();
  const dProblem = domainProblem(d, [], previewBases);
  const www = d && !d.startsWith("www.") ? `www.${d}` : null;
  const norm = aliases.map((a) => a.trim().toLowerCase());
  const problemText = (p: DomainProblem, name: string) =>
    p === "invalid" ? t("live.domainInvalid") : p === "preview" ? t("live.domainPreview", { domain: name }) : p === "duplicate" ? t("live.domainDuplicate", { domain: name }) : null;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-domain`}>{t("live.domain")}</Label>
        <Input
          id={`${uid}-domain`}
          value={domain}
          maxLength={253}
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          className="font-mono"
          placeholder={t("live.domainPlaceholder")}
          aria-invalid={!!dProblem}
          aria-describedby={`${uid}-domain-help`}
          onChange={(e) => onDomain(e.target.value)}
        />
        <p id={`${uid}-domain-help`} className={cn("text-xs", dProblem ? "text-destructive" : "text-muted-foreground")}>
          {problemText(dProblem, d) ?? t("live.domainHelp")}
        </p>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t("live.aliases")}</legend>
        <p className="text-xs text-muted-foreground">{t("live.aliasesHelp", { max: MAX_ALIASES })}</p>
        {aliases.map((a, i) => {
          const p = domainProblem(norm[i]!, [d, ...norm.filter((_, j) => j !== i)], previewBases);
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  value={a}
                  maxLength={253}
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode="url"
                  className="font-mono"
                  aria-label={t("live.aliasLabel", { n: i + 1 })}
                  aria-invalid={!!p}
                  onChange={(e) => onAliases(aliases.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <Button type="button" size="icon" variant="ghost" className="size-9 shrink-0" aria-label={t("live.aliasRemove", { name: a || t("live.aliasLabel", { n: i + 1 }) })} onClick={() => onAliases(aliases.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              </div>
              {p && <p className="text-xs text-destructive">{problemText(p, norm[i]!)}</p>}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          {www && !norm.includes(www) && aliases.length < MAX_ALIASES && !dProblem && (
            <Button type="button" size="sm" variant="outline" className="gap-1.5 font-mono" onClick={() => onAliases([...aliases.filter((x) => x.trim()), www])}>
              <Plus className="size-3.5" aria-hidden /> {www}
            </Button>
          )}
          {aliases.length < MAX_ALIASES && (
            <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => onAliases([...aliases, ""])}>
              <Plus className="size-3.5" aria-hidden /> {t("live.aliasAdd")}
            </Button>
          )}
        </div>
      </fieldset>
    </div>
  );
}

function namesValid(domain: string, aliases: string[], previewBases: string[]) {
  const d = domain.trim().toLowerCase();
  const norm = aliases.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!d || domainProblem(d, [], previewBases)) return false;
  return norm.every((a, i) => !domainProblem(a, [d, ...norm.filter((_, j) => j !== i)], previewBases));
}

/**
 * "Set up LIVE": the client's server (servers with the live role first), the domain and the names that redirect to
 * it. The Owner, confirmed with a step-up. The page then shows the DNS records to create.
 */
export function SetupLiveDialog({ app, onClose, onCreated }: { app: AppDTO; onClose: () => void; onCreated?: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const withStepUp = useStepUp();
  const servers = useServers();
  const ready = (servers.data ?? []).filter((s) => s.status === "ready").sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "live" ? -1 : b.role === "live" ? 1 : 0));
  const previewBases = (servers.data ?? []).map((s) => s.baseDomain.toLowerCase());
  const [serverId, setServerId] = useState("");
  const [domain, setDomain] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const server = ready.find((s) => s.id === (serverId || ready[0]?.id));
  const valid = !!server && namesValid(domain, aliases, previewBases);
  const m = useMutation({
    mutationFn: () =>
      withStepUp(() =>
        api.post<{ app: AppDTO }>(`/api/apps/${app.id}/live`, {
          serverId: server!.id,
          domain: domain.trim().toLowerCase(),
          extraDomains: aliases.map((a) => a.trim().toLowerCase()).filter(Boolean),
        }),
      ),
    onSuccess: (r) => {
      if (!r) return;
      invalidateApp(qc, app.id);
      toast.success(t("live.created"));
      onCreated?.();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {t("live.setupTitle", { name: app.name })} <EnvPlate kind="live" />
          </DialogTitle>
          <DialogDescription>{t("live.setupDescription")}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) m.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-server`}>{t("form.server")}</Label>
            <select id={`${uid}-server`} className={selectClass} value={server?.id ?? ""} disabled={!ready.length} onChange={(e) => setServerId(e.target.value)}>
              {ready.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.role === "live" ? t("live.serverLive", { name: s.name }) : t("live.serverDev", { name: s.name })}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{server?.role === "live" ? t("live.serverHelp") : t("live.serverDevHelp")}</p>
          </div>
          <DomainFields domain={domain} aliases={aliases} onDomain={setDomain} onAliases={setAliases} previewBases={previewBases} />
          <ul className="space-y-1 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            <li>{t("live.setupNoteSeparate")}</li>
            <li>{t("live.setupNotePublic")}</li>
            <li>{t("live.setupNoteDns")}</li>
          </ul>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} className="gap-1.5" disabled={!valid || m.isPending}>
            <Radio className="size-4" aria-hidden /> {t("live.setupConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Domain, redirecting names, access and release window of the live environment. Names change only while it is
 * stopped; a new release window is confirmed with a step-up.
 */
export function EditLiveDialog({ app, env, onClose }: { app: AppDTO; env: AppEnvironmentDTO; onClose: () => void }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const withStepUp = useStepUp();
  const [releaseWindow, setReleaseWindow] = useState<ReleaseWindow | null>(env.releaseWindow);
  const windowChanged = !sameReleaseWindow(releaseWindow, env.releaseWindow);
  const windowValid = !releaseWindow || (/^\d\d:\d\d$/.test(releaseWindow.start) && /^\d\d:\d\d$/.test(releaseWindow.end) && releaseWindow.days.length > 0);
  const servers = useServers();
  const previewBases = (servers.data ?? []).map((s) => s.baseDomain.toLowerCase());
  const [domain, setDomain] = useState(env.domain);
  const [aliases, setAliases] = useState<string[]>(env.extraDomains);
  const [accessMode, setAccessMode] = useState<AppAccessMode>(env.accessMode);
  const running = env.status === "running" || env.status === "deploying";
  const extra = aliases.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const namesChanged = domain.trim().toLowerCase() !== env.domain || extra.join(",") !== env.extraDomains.join(",");
  const valid = namesValid(domain, aliases, previewBases) && !(namesChanged && running) && windowValid;
  const changed = namesChanged || accessMode !== env.accessMode || windowChanged;
  const m = useMutation({
    mutationFn: () => {
      const send = () =>
        api.patch<{ app: AppDTO }>(`/api/apps/${app.id}/live`, {
          ...(namesChanged && { domain: domain.trim().toLowerCase(), extraDomains: extra }),
          ...(accessMode !== env.accessMode && { accessMode }),
          ...(windowChanged && { releaseWindow }),
        });
      // the release window guards the live site: the server asks for a fresh step-up
      return windowChanged ? withStepUp(send) : send();
    },
    onSuccess: (r) => {
      if (!r) return;
      invalidateApp(qc, app.id);
      toast.success(t("live.saved"));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const options = [
    { v: "public" as const, icon: Globe, label: t("live.accessPublic"), help: t("live.accessPublicHelp") },
    { v: "password" as const, icon: KeyRound, label: t("form.accessPassword"), help: t("live.accessPasswordHelp") },
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {t("live.editTitle")} <EnvPlate kind="live" status={env.status} />
          </DialogTitle>
          <DialogDescription>{running ? t("live.editRunning") : t("live.editDescription")}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) m.mutate();
          }}
        >
          <fieldset disabled={running} className="disabled:opacity-60">
            <DomainFields domain={domain} aliases={aliases} onDomain={setDomain} onAliases={setAliases} previewBases={previewBases} />
          </fieldset>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("form.access")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((o) => (
                <label
                  key={o.v}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    accessMode === o.v ? "border-foreground bg-secondary/60" : "hover:bg-secondary/40",
                  )}
                >
                  <input type="radio" name={`${uid}-access`} value={o.v} checked={accessMode === o.v} onChange={() => setAccessMode(o.v)} className="sr-only" />
                  <o.icon className={cn("mt-0.5 size-4 shrink-0", accessMode === o.v ? "text-foreground" : "text-muted-foreground")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <ReleaseWindowFields value={releaseWindow} onChange={setReleaseWindow} />
          {namesChanged && <p className="text-xs text-muted-foreground">{t("live.namesResetDns")}</p>}
          {windowChanged && <p className="text-xs text-muted-foreground">{t("window.stepUp")}</p>}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!valid || m.isPending || !changed}>
            {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanRow({ icon: Icon, tone, title, children }: { icon: typeof Zap; tone?: string; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone ?? "text-muted-foreground")} aria-hidden />
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/**
 * How the picked version reaches live: a backup of the live database first (when it has one), then its migrations
 * while the old version serves ("expand", no downtime) or behind the maintenance page ("breaking"); the old version
 * keeps running for a short grace after the switch, for an instant rollback.
 */
function LiveReleasePlan({ plan, hasDatabase, replacing }: { plan: ReleaseDbPlan | undefined; hasDatabase: boolean; replacing: boolean }) {
  const t = useTranslations("apps");
  const db = plan ? plan.database || hasDatabase : hasDatabase;
  return (
    <ul className="space-y-2.5 rounded-lg border border-dashed p-3" aria-label={t("live.planTitle")}>
      {db && (
        <PlanRow icon={DatabaseBackup} title={t("live.planBackup")}>
          {t("live.planBackupHelp")}
        </PlanRow>
      )}
      {!db ? (
        <PlanRow icon={Zap} tone="text-success" title={t("live.planNoDowntime")}>
          {t("live.planNoDatabase")}
        </PlanRow>
      ) : plan?.migrations === "expand" ? (
        <PlanRow icon={Zap} tone="text-success" title={t("live.planNoDowntime")}>
          {t("live.planExpand")}
        </PlanRow>
      ) : plan?.migrations === "breaking" ? (
        <PlanRow icon={Construction} tone="text-warning" title={t("live.planMaintenance")}>
          {t("live.planBreaking")}
        </PlanRow>
      ) : (
        <PlanRow icon={Construction} tone="text-warning" title={t("live.planUnknown")}>
          {t("live.planUnknownHelp")}
        </PlanRow>
      )}
      {replacing && (
        <PlanRow icon={Repeat} title={t("live.planGrace")}>
          {t("live.planGraceHelp", { minutes: Math.round(APP_LIVE_GRACE_SECONDS / 60) })}
        </PlanRow>
      )}
    </ul>
  );
}

/** a small mark per version in the list: how its migrations reach live */
function MigrationMark({ plan, hasDatabase }: { plan: ReleaseDbPlan | undefined; hasDatabase: boolean }) {
  const t = useTranslations("apps");
  if (!plan || !(plan.database || hasDatabase)) return null;
  return plan.migrations === "expand" ? <span className="text-success">{t("live.markExpand")}</span> : <span className="text-warning">{t("live.markBreaking")}</span>;
}

/**
 * "Release to LIVE": one of the versions that ran in the preview (newest first, the one running there now marked),
 * its exact commit then goes live. The Owner, with a step-up; refused until the DNS check is ok.
 */
export function ReleaseToLiveDialog({
  app,
  live,
  releases,
  envChanged,
  dbPlans,
  onClose,
}: {
  app: AppDTO;
  live: AppEnvironmentDTO;
  releases: ReleaseDTO[];
  /** what each preview release's manifest says about its database (none for a release without a manifest) */
  dbPlans: Record<string, ReleaseDbPlan>;
  /** live env names changed since the release live now */
  envChanged: string[];
  onClose: () => void;
}) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const uid = useId();
  const withStepUp = useStepUp();
  const candidates = releases
    .filter((r) => r.environmentKind === "preview" && (r.status === "deployed" || r.status === "superseded") && !!r.commit)
    .sort((a, b) => ((b.finishedAt ?? b.createdAt) > (a.finishedAt ?? a.createdAt) ? 1 : -1));
  const [picked, setPicked] = useState(candidates[0]?.id ?? "");
  const liveCommit = live.currentRelease?.commit ?? null;
  const dnsOk = live.dnsCheck?.status === "ok";
  const now = useNow();
  const inWindow = releaseWindowState(live.releaseWindow, now).open;
  const m = useMutation({
    mutationFn: () => withStepUp(() => api.post<{ release: ReleaseDTO }>(`/api/apps/${app.id}/deploy?env=live`, { fromReleaseId: picked })),
    onSuccess: (r) => {
      if (!r) return;
      invalidateApp(qc, app.id);
      toast.success(t("live.releaseQueued"));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {t("live.releaseTitle", { name: app.name })} <EnvPlate kind="live" status={live.status} />
          </DialogTitle>
          <DialogDescription>{t("live.releaseDescription", { domain: live.domain })}</DialogDescription>
        </DialogHeader>
        {!dnsOk && <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">{t("live.releaseDnsFirst")}</p>}
        <ReleaseWindowNote w={live.releaseWindow} now={now} />
        {envChanged.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-dashed p-2.5 text-xs">
            <p className="text-muted-foreground">{t("live.releaseEnvChanged", { count: envChanged.length })}</p>
            <ul className="flex flex-wrap gap-1.5">
              {envChanged.map((k) => (
                <li key={k}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">{k}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!candidates.length ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("live.releaseNone")}</p>
        ) : (
          <form
            id={`${uid}-form`}
            onSubmit={(e) => {
              e.preventDefault();
              if (picked && dnsOk && inWindow) m.mutate();
            }}
          >
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t("live.releasePick")}</legend>
              <ul className="max-h-[45dvh] space-y-1.5 overflow-y-auto pr-1">
                {candidates.map((r) => (
                  <li key={r.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                        picked === r.id ? "border-[var(--sign-merah)] bg-[color-mix(in_srgb,var(--sign-merah)_7%,transparent)]" : "hover:bg-secondary/40",
                      )}
                    >
                      <input type="radio" name={`${uid}-rel`} value={r.id} checked={picked === r.id} onChange={() => setPicked(r.id)} className="mt-1 accent-[var(--sign-merah)]" />
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <CommitChip sha={r.commit} />
                          <span className="min-w-0 truncate text-sm font-medium">{r.commitSubject ?? r.branch}</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t("live.releaseRan", { ago: f.ago(r.finishedAt ?? r.createdAt) })}
                          {r.createdByName ? ` · ${r.createdByName}` : ""}
                          {" · "}
                          <code className="font-mono">{r.branch}</code>
                        </span>
                        <span className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
                          {r.id === app.preview.currentRelease?.id && <span className="text-success">{t("live.releaseInPreview")}</span>}
                          {r.commit === liveCommit && <span className="text-[var(--sign-merah)]">{t("live.releaseIsLive")}</span>}
                          <MigrationMark plan={dbPlans[r.id]} hasDatabase={live.hasDatabase} />
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            {picked && (
              <div className="mt-3">
                <LiveReleasePlan plan={dbPlans[picked]} hasDatabase={live.hasDatabase} replacing={!!live.currentRelease && live.status === "running"} />
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("live.releaseAudited")}</p>
          </form>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          {!!candidates.length && (
            <Button type="submit" form={`${uid}-form`} className="gap-1.5" disabled={!picked || !dnsOk || !inWindow || m.isPending}>
              <Radio className="size-4" aria-hidden /> {t("live.releaseConfirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The last word before the live site and its database go (removing LIVE, or the whole app with it): the Owner types
 * the live domain. The server keeps a final database dump for 30 days.
 */
export function ConfirmLiveRemovalDialog({
  title,
  description,
  domain,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  domain: string;
  pending: boolean;
  onConfirm: (typed: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const uid = useId();
  const [typed, setTyped] = useState("");
  const ok = typed.trim().toLowerCase() === domain;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm(typed.trim().toLowerCase());
          }}
        >
          <p className="rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">{t("live.removeDump")}</p>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-domain`}>{t.rich("live.removeType", { domain, b: (c) => <code className="font-mono font-semibold text-foreground">{c}</code> })}</Label>
            <Input id={`${uid}-domain`} autoFocus value={typed} autoCapitalize="none" spellCheck={false} autoComplete="off" className="font-mono" onChange={(e) => setTyped(e.target.value)} />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} variant="destructive" className="gap-1.5" disabled={!ok || pending}>
            <Trash2 className="size-4" aria-hidden /> {t("live.removeFinal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
