"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { APP_IDLE_STOP_DAYS, hasRole, type AppDTO, type AppEnvironmentDTO, type AppEnvironmentKind, type AppStatus, type ReleaseDTO, type ReleaseStatus } from "@wfos/shared";
import { api } from "@/lib/api";
import type { ReleaseDbPlan, ReleaseOrigin } from "@/lib/app-previews";
import { useMe } from "@/lib/hooks";
import { signColors, signVars, type SignColor, type SignState } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

/** ["apps"] list, ["app", id] detail, ["release", id] log: invalidated by app.updated / release.updated (lib/events.tsx) */
export const appsQueryKey = ["apps"] as const;
export const appQueryKey = (id: string) => ["app", id] as const;
export const releaseQueryKey = (id: string) => ["release", id] as const;

export interface AppDetail {
  app: AppDTO;
  releases: ReleaseDTO[];
  /** the task behind each release a task triggered (request_preview), keyed by task id */
  origins: Record<string, ReleaseOrigin>;
  /** live env names changed since the release live now (names only) */
  liveEnvChanged: string[];
  /** with a live environment: what each preview release's manifest says about its database (Release to LIVE) */
  dbPlans: Record<string, ReleaseDbPlan>;
}

export const ACTIVE_RELEASE: readonly ReleaseStatus[] = ["queued", "deploying"];
export const isActiveRelease = (r: Pick<ReleaseDTO, "status">) => ACTIVE_RELEASE.includes(r.status);

export const useApps = () => useQuery({ queryKey: appsQueryKey, queryFn: () => api.get<{ apps: AppDTO[] }>("/api/apps").then((r) => r.apps) });

export function useApp(id: string) {
  return useQuery({
    queryKey: appQueryKey(id),
    queryFn: () => api.get<AppDetail>(`/api/apps/${id}`),
    // the live stream refreshes it; while a release or a restore runs, also poll (a dropped stream must not freeze the page)
    refetchInterval: (q) => {
      const d = q.state.data;
      const busy = d?.releases.some(isActiveRelease) || d?.app.preview.status === "deploying" || d?.app.live?.status === "deploying";
      return busy || d?.app.live?.maintenance || d?.app.preview.maintenance ? 5000 : false;
    },
  });
}

/** the query string of an environment route: nothing for the preview (the default), ?env=live for the live one */
export const envQuery = (kind: AppEnvironmentKind) => (kind === "live" ? "?env=live" : "");

/** an app's state as one environment: running when either runs (the sign lights for any served version) */
export function appSignStatus(app: Pick<AppDTO, "preview" | "live">): AppStatus {
  const order: AppStatus[] = ["running", "deploying", "failed", "stopped", "new"];
  const states = [app.preview.status, app.live?.status].filter((x): x is AppStatus => !!x);
  return order.find((s) => states.includes(s)) ?? "new";
}

/** what the signed-in person may do here: Admins change apps, the Owner stops all, Members and up read logs */
export function useAppRights() {
  const { data: me } = useMe();
  const role = me?.role;
  return { admin: !!role && hasRole(role, "ADMIN"), owner: role === "OWNER", logs: !!role && hasRole(role, "MEMBER"), role };
}

export function invalidateApp(qc: QueryClient, id: string) {
  void qc.invalidateQueries({ queryKey: appQueryKey(id) });
  void qc.invalidateQueries({ queryKey: appsQueryKey });
}

/** an app's sign: lit while it serves, flickering while it is down, switched off otherwise */
const SIGN_STATE: Record<AppStatus, SignState> = { running: "lit", deploying: "starting", stopped: "off", new: "off", failed: "fault" };

/** each app keeps its own colour across the list and its page (dealt from all the workspace's app ids) */
export function appColors(ids: readonly string[]): Map<string, SignColor> {
  return signColors(ids);
}

export function AppSign({ app, color, size = "md", className }: { app: { name: string; status: AppStatus }; color: SignColor; size?: "md" | "lg"; className?: string }) {
  return (
    <span
      className={cn(
        "sign font-display inline-block max-w-full truncate rounded-md",
        size === "lg" ? "px-4 pt-2.5 pb-1.5 text-[2.4rem] leading-none sm:text-[2.9rem]" : "px-2.5 pt-1.5 pb-1 text-[1.45rem] leading-none",
        className,
      )}
      style={signVars(color)}
      data-state={SIGN_STATE[app.status]}
    >
      {app.name}
    </span>
  );
}

const pill = "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-sans text-xs font-medium whitespace-nowrap normal-case tracking-normal";

const APP_TONE: Record<AppStatus, string> = {
  new: "bg-muted text-muted-foreground",
  deploying: "bg-[color-mix(in_srgb,var(--sign-biru)_22%,transparent)] text-foreground",
  running: "bg-success/15 text-success",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
};

export function AppStatusBadge({ status, className }: { status: AppStatus; className?: string }) {
  const t = useTranslations("apps");
  return (
    <span className={cn(pill, APP_TONE[status], className)}>
      {(status === "deploying" || status === "running") && <span className={cn("size-1.5 rounded-full bg-current", status === "deploying" && "animate-pulse")} aria-hidden />}
      {t(`status.${status}`)}
    </span>
  );
}

const RELEASE_TONE: Record<ReleaseStatus, string> = {
  queued: "bg-secondary text-secondary-foreground",
  deploying: "bg-[color-mix(in_srgb,var(--sign-biru)_22%,transparent)] text-foreground",
  deployed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  rolled_back: "bg-warning/20 text-warning",
  superseded: "bg-muted text-muted-foreground",
};

export function ReleaseStatusBadge({ status, className }: { status: ReleaseStatus; className?: string }) {
  const t = useTranslations("apps");
  return (
    <span className={cn(pill, RELEASE_TONE[status], className)}>
      {status === "deploying" && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {t(`releases.status.${status}`)}
    </span>
  );
}

/** a dot for the last health check: green answering, red not, hollow when never checked */
export function HealthDot({ app, withLabel }: { app: Pick<AppEnvironmentDTO, "healthy" | "lastHealthAt" | "status">; withLabel?: boolean }) {
  const t = useTranslations("apps");
  const f = useFormat();
  const state = app.healthy === null || app.status !== "running" ? "unknown" : app.healthy ? "healthy" : "unhealthy";
  const label = t(`health.${state}`) + (app.lastHealthAt && state !== "unknown" ? ` · ${t("health.checked", { ago: f.ago(app.lastHealthAt) })}` : "");
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={label}>
      <span
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          state === "healthy" && "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_22%,transparent)]",
          state === "unhealthy" && "bg-destructive shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_22%,transparent)]",
          state === "unknown" && "border border-muted-foreground/50",
        )}
        aria-hidden
      />
      {withLabel ? label : <span className="sr-only">{label}</span>}
    </span>
  );
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * The environment's own small acrylic plate: PREVIEW in blue, LIVE in red. Lit while that environment serves, dark
 * otherwise, so a glance at the page tells which one is on.
 */
export function EnvPlate({ kind, status, className }: { kind: AppEnvironmentKind; status?: AppStatus; className?: string }) {
  const t = useTranslations("apps");
  const state: SignState = status ? SIGN_STATE[status] : "lit";
  return (
    <span
      className={cn("sign font-display inline-flex shrink-0 items-center gap-1 rounded px-1.5 pt-[3px] pb-[1px] text-[0.8rem] leading-none tracking-[0.08em]", className)}
      style={signVars(kind === "live" ? "merah" : "biru")}
      data-state={state}
    >
      {kind === "live" && <span className={cn("size-1.5 rounded-full bg-current", state === "lit" && "animate-pulse motion-reduce:animate-none")} aria-hidden />}
      {t(`environments.${kind}`)}
    </span>
  );
}

/** "a1b2c3d" in a mono plate; the full hash on hover */
export function CommitChip({ sha, className }: { sha: string; className?: string }) {
  return (
    <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-tight", className)} title={sha}>
      {shortSha(sha)}
    </code>
  );
}

/** the text of a status message code, null when there is none */
export function useStatusMessage() {
  const t = useTranslations("apps");
  return (code: string | null): string | null => (code && t.has(`statusMessage.${code}`) ? t(`statusMessage.${code}`, { days: APP_IDLE_STOP_DAYS }) : code);
}

/** "3 min 05 s" from a release's start and end */
export function useDuration() {
  const t = useTranslations("apps");
  return (r: Pick<ReleaseDTO, "startedAt" | "finishedAt">, now = Date.now()): string | null => {
    if (!r.startedAt) return null;
    const ms = (r.finishedAt ? new Date(r.finishedAt).getTime() : now) - new Date(r.startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const total = Math.round(ms / 1000);
    return t("releases.duration", { minutes: Math.floor(total / 60), seconds: total % 60 });
  };
}

export const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export async function copyText(text: string, done: string, toast: { success: (m: string) => void }) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    // clipboard blocked (http, permissions): the text stays selectable on the page
  }
}
