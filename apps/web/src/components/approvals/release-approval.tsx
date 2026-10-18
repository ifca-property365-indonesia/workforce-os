"use client";

import Link from "@/lib/nav";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Construction, DatabaseBackup, ExternalLink, FileCode2, FlaskConical, GitCommitHorizontal, KeyRound, Sparkles, Zap } from "lucide-react";
import { requestReleasePayloadSchema, type ReleaseWindow, type RequestReleasePayload } from "@wfos/shared";
import { ReleaseWindowNote, releaseWindowState, useNow } from "@/components/apps/release-window";
import { LOUD_WARNINGS } from "@/components/apps/releases";
import { AppSign, CommitChip, EnvPlate, ReleaseStatusBadge, appColors, useApps } from "@/components/apps/shared";
import { api } from "@/lib/api";
import { signVars } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { FileBar, releaseOutcome } from "./preview-approval";
import type { Approval } from "./types";

/** how long a proposed LIVE release can be approved (the server refuses older ones: release_request_expired) */
const RELEASE_REQUEST_TTL_MS = 24 * 3_600_000;

/**
 * Whether a pending request_release can be approved now, as the server will judge it: the live environment's current
 * release window (it may have changed since the request; else the payload's), the request's age (24 h) and whether
 * LIVE still runs the commit the request was made against. Any of these holds Approve back; Reject never waits.
 */
export function useReleaseApprovalWindow(a: Pick<Approval, "toolName" | "payload" | "createdAt">) {
  const { data: apps } = useApps();
  const now = useNow();
  const none = { closed: false, expired: false, stale: false, blocked: false, now, window: null as ReleaseWindow | null };
  if (a.toolName !== "request_release") return none;
  const parsed = requestReleasePayloadSchema.safeParse(a.payload);
  if (!parsed.success) return none;
  const live = apps?.find((x) => x.id === parsed.data.appId)?.live;
  const w = live ? live.releaseWindow : parsed.data.releaseWindow;
  const closed = !releaseWindowState(w, now).open;
  const expired = now.getTime() - new Date(a.createdAt).getTime() > RELEASE_REQUEST_TTL_MS;
  // only once the apps have loaded: an unknown LIVE is not "changed"
  const stale = !!apps && (!live || (live.currentRelease?.commit ?? null) !== parsed.data.currentCommit);
  return { closed, expired, stale, blocked: closed || expired || stale, now, window: w };
}

/**
 * C3: the latest browser test of the app's preview, next to a LIVE release decision: passed, findings or never tested,
 * and whether it tested this very commit.
 */
function LastTest({ appId, commit }: { appId: string; commit: string }) {
  const t = useTranslations("approvals");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: ["app", appId, "tests", "last"],
    queryFn: () => api.get<{ tests: { id: string; status: string; commit: string | null; findings: unknown[]; finishedAt: string | null; createdAt: string }[] }>(`/api/apps/${appId}/tests?limit=1`),
    retry: false,
  });
  if (!data) return null;
  const last = data.tests[0];
  const text = !last
    ? t("release.testNever")
    : t(`release.test.${last.status === "passed" || last.status === "findings" || last.status === "running" ? last.status : "error"}`, { count: last.findings.length, when: f.ago(last.finishedAt ?? last.createdAt) });
  const sameCommit = !!last?.commit && last.commit === commit;
  return (
    <p className={cn("flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs", last?.status === "passed" && sameCommit ? "bg-success/10" : "bg-warning/15")}>
      <FlaskConical className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        {text}
        {last?.commit && !sameCommit && ` ${t("release.testOtherCommit", { commit: last.commit.slice(0, 8) })}`}{" "}
        <Link href={`/apps/${appId}${last ? `?test=${last.id}` : ""}`} className="underline underline-offset-2">
          {t("release.testOpen")}
        </Link>
      </span>
    </p>
  );
}

function PlanRow({ icon: Icon, tone, title, children }: { icon: typeof Zap; tone?: string; title: string; children: string }) {
  return (
    <li className="flex gap-2.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone ?? "text-muted-foreground")} aria-hidden />
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/**
 * request_release: a version that ran in the preview, proposed for the client's LIVE site. The app's sign under a red
 * LIVE plate, the live address, which commit replaces which, what changed, how the database migrates (and whether
 * visitors see the maintenance page), the backup first, the live variables changed since, the release window, the
 * Developer's summary, and that only the Owner decides. Read only: approved or rejected as proposed, never edited.
 */
export function ReleaseApprovalPreview({ a, payload }: { a: Approval; payload: Record<string, unknown> }) {
  const t = useTranslations("approvals");
  const ta = useTranslations("apps");
  const f = useFormat();
  const { data: apps } = useApps();
  const win = useReleaseApprovalWindow(a);
  const parsed = requestReleasePayloadSchema.safeParse(payload);
  if (!parsed.success) return <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{JSON.stringify(payload, null, 2)}</pre>;
  const p: RequestReleasePayload = parsed.data;
  const known = apps?.find((x) => x.id === p.appId);
  const color = appColors((apps ?? []).map((x) => x.id).concat(known ? [] : [p.appId])).get(p.appId) ?? "biru";
  const outcome = releaseOutcome(a);
  const maxLines = Math.max(0, ...p.files.map((x) => x.added + x.removed));
  const totals = p.files.reduce((s, x) => ({ added: s.added + x.added, removed: s.removed + x.removed }), { added: 0, removed: 0 });
  const host = p.url.replace(/^https?:\/\//, "");
  const pending = a.status === "PENDING";

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--sign-merah)]/45 bg-background text-sm" style={signVars("merah")}>
      {/* the shopfront: the app's sign over its LIVE address, a red kerb */}
      <div className="relative space-y-2.5 border-b border-[var(--sign-merah)]/30 bg-[color-mix(in_srgb,var(--sign-merah)_7%,transparent)] px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <AppSign app={{ name: p.appName, status: known?.live?.status ?? "running" }} color={color} />
            <EnvPlate kind="live" />
          </span>
          {p.currentCommit ? (
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("release.update")}</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--sign-merah)] px-2 py-0.5 text-[11px] font-semibold tracking-wide text-white uppercase">
              <Sparkles className="size-3" aria-hidden /> {t("release.firstRelease")}
            </span>
          )}
        </div>
        <a
          href={p.url.startsWith("https://") ? p.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-2 rounded-lg border-2 border-dashed border-[var(--sign-merah)]/55 bg-background/70 px-3 py-1.5 font-mono text-xs font-semibold transition-colors hover:border-foreground/50"
        >
          <span className="min-w-0 truncate">{host}</span>
          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">{t("release.openLive")}</span>
        </a>
        <p className="text-xs text-muted-foreground">{t("release.realSite")}</p>
      </div>

      <div className="space-y-4 px-4 py-3">
        {/* the swap: what LIVE runs now → the preview version that replaces it */}
        <div className="flex flex-wrap items-center gap-2">
          {p.currentCommit ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("release.runsNow")} <CommitChip sha={p.currentCommit} />
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("release.nothingLive")}</span>
          )}
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <CommitChip sha={p.commit} className="bg-[color-mix(in_srgb,var(--sign-merah)_18%,transparent)] text-foreground" />
            {p.commitSubject && <span className="min-w-0 truncate font-medium">{p.commitSubject}</span>}
          </span>
          <span className="basis-full text-[11px] text-muted-foreground">{t("release.ranInPreview")}</span>
        </div>

        {p.summary && (
          <blockquote className="border-l-4 border-[var(--sign-merah)] bg-muted/30 py-2 pr-3 pl-3 break-words whitespace-pre-wrap">
            <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("preview.summary", { name: a.employee?.name ?? t("preview.theDeveloper") })}</div>
            {p.summary}
          </blockquote>
        )}

        {p.warnings.length > 0 && (
          <section aria-label={t("preview.warnings")}>
            <ul className="space-y-1">
              {p.warnings.map((w) => (
                <li
                  key={w}
                  className={cn("flex gap-1.5 rounded-md px-2 py-1.5 text-xs", LOUD_WARNINGS.has(w) ? "border border-warning/40 bg-warning/10 text-warning" : "bg-muted/50 text-muted-foreground")}
                >
                  {LOUD_WARNINGS.has(w) && <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />}
                  <span>
                    <span className="font-semibold">{ta(`releases.warning.${w}`)}:</span> {ta(`releases.warningHelp.${w}`)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* how it reaches LIVE: backup, then migrations without downtime or behind the maintenance page */}
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("release.howTitle")}</h4>
          <ul className="space-y-2 rounded-lg border border-dashed p-2.5">
            {p.database && (
              <PlanRow icon={DatabaseBackup} title={ta("live.planBackup")}>
                {ta("live.planBackupHelp")}
              </PlanRow>
            )}
            {!p.database ? (
              <PlanRow icon={Zap} tone="text-success" title={ta("live.planNoDowntime")}>
                {ta("live.planNoDatabase")}
              </PlanRow>
            ) : p.migrations === "expand" ? (
              <PlanRow icon={Zap} tone="text-success" title={ta("live.planNoDowntime")}>
                {ta("live.planExpand")}
              </PlanRow>
            ) : (
              <PlanRow icon={Construction} tone="text-warning" title={ta("live.planMaintenance")}>
                {ta("live.planBreaking")}
              </PlanRow>
            )}
          </ul>
        </section>

        {p.liveEnvChanged.length > 0 && (
          <section className="space-y-1.5 rounded-md border border-dashed p-2.5 text-xs">
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <KeyRound className="size-3.5 shrink-0" aria-hidden /> {ta("live.releaseEnvChanged", { count: p.liveEnvChanged.length })}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {p.liveEnvChanged.map((k) => (
                <li key={k}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">{k}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {p.commits.length > 0 && (
          <section className="space-y-1">
            <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {p.currentCommit ? t("release.commitsSince", { count: p.commits.length }) : t("preview.commitsFirst", { count: p.commits.length })}
            </h4>
            <ul className="max-h-48 space-y-0.5 overflow-auto text-xs">
              {p.commits.map((c) => (
                <li key={c.sha} className="flex min-w-0 items-center gap-2">
                  <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <code className="shrink-0 font-mono text-muted-foreground">{c.sha.slice(0, 7)}</code>
                  <span className="min-w-0 truncate">{c.subject}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {p.files.length > 0 && (
          <section className="space-y-1">
            <h4 className="flex flex-wrap items-baseline gap-x-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("preview.files", { count: p.files.length })}
              <span className="font-mono tracking-normal normal-case tabular-nums">
                <span className="text-success">+{f.number(totals.added)}</span> <span className="text-destructive">−{f.number(totals.removed)}</span>
              </span>
            </h4>
            <ul className="max-h-60 divide-y overflow-auto rounded-lg border text-xs">
              {p.files.map((x) => (
                <li key={x.path} className="flex items-center gap-2 px-2 py-1">
                  <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono" title={x.path}>
                    {x.path}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">
                    <span className="text-success">+{x.added}</span> <span className="text-destructive">−{x.removed}</span>
                  </span>
                  <FileBar added={x.added} removed={x.removed} max={maxLines} />
                </li>
              ))}
            </ul>
            {p.filesTruncated && <p className="text-xs text-muted-foreground">{t("preview.filesTruncated")}</p>}
          </section>
        )}

        {pending && win.window ? <ReleaseWindowNote w={win.window} now={win.now} /> : null}
        {pending && win.closed && <p className="text-xs font-semibold text-warning">{t("release.waitForWindow")}</p>}
        {pending && win.stale && (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {t("release.stale")}
          </p>
        )}
        {pending && win.expired && (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs font-semibold text-warning">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {t("release.expired")}
          </p>
        )}

        {outcome ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <ReleaseStatusBadge status={outcome.status} />
            {outcome.status === "deployed" && outcome.url ? (
              <a href={outcome.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
                {t("preview.liveAt", { url: outcome.url.replace(/^https:\/\//, "") })} <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
            <Link href={`/apps/${p.appId}`} className="ml-auto text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {t("preview.followOnApp")}
            </Link>
          </div>
        ) : a.status === "EXECUTED" ? (
          <Link href={`/apps/${p.appId}`} className="inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {t("preview.followOnApp")}
          </Link>
        ) : null}

        <LastTest appId={p.appId} commit={p.commit} />

        <p className="rounded-md bg-[color-mix(in_srgb,var(--sign-merah)_9%,transparent)] px-2.5 py-2 text-xs">
          <span className="font-semibold">{t("release.ownerOnly")}</span> {t("release.howItRuns", { commit: p.commit.slice(0, 7) })}
        </p>
      </div>
    </div>
  );
}
