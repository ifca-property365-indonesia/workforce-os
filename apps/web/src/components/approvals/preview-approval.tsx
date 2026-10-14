"use client";

import Link from "@/lib/nav";
import { useTranslations } from "next-intl";
import { AlertTriangle, ArrowRight, Database, DatabaseZap, ExternalLink, FileCode2, GitBranch, GitCommitHorizontal, HardDrive, HeartPulse, Server, Sparkles } from "lucide-react";
import { requestPreviewPayloadSchema, type ReleaseStatus, type RequestPreviewPayload } from "@wfos/shared";
import { LOUD_WARNINGS } from "@/components/apps/releases";
import { AppSign, CommitChip, ReleaseStatusBadge, appColors, useApps } from "@/components/apps/shared";
import { signVars } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import type { Approval } from "./types";

const RELEASE_STATUSES: readonly ReleaseStatus[] = ["queued", "deploying", "deployed", "failed", "rolled_back", "superseded"];

/** what the worker recorded once the preview ran: executionResult.details.release = { id, status, url } */
export function releaseOutcome(a: Approval): { id: string; status: ReleaseStatus; url: string | null } | null {
  const details = a.executionResult?.details as { release?: { id?: unknown; status?: unknown; url?: unknown } } | undefined;
  const r = details?.release;
  if (!r || typeof r.id !== "string" || !RELEASE_STATUSES.includes(r.status as ReleaseStatus)) return null;
  return { id: r.id, status: r.status as ReleaseStatus, url: typeof r.url === "string" && r.url.startsWith("https://") ? r.url : null };
}

export function FileBar({ added, removed, max }: { added: number; removed: number; max: number }) {
  const scale = (n: number) => (max > 0 && n > 0 ? Math.max(2, Math.round((n / max) * 48)) : 0);
  return (
    <span className="flex h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className="bg-success" style={{ width: scale(added) }} />
      <span className="bg-destructive" style={{ width: scale(removed) }} />
    </span>
  );
}

/**
 * request_preview: the app (as its sign) and its address, which commit replaces which, what changed, the release
 * warnings explained, what wfos-app.json asks of the server, and the Developer's own summary. Read only: a preview is
 * approved or rejected for exactly this commit, never edited.
 */
export function PreviewApprovalPreview({ a, payload }: { a: Approval; payload: Record<string, unknown> }) {
  const t = useTranslations("approvals");
  const ta = useTranslations("apps");
  const f = useFormat();
  const { data: apps } = useApps();
  const parsed = requestPreviewPayloadSchema.safeParse(payload);
  if (!parsed.success) return <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{JSON.stringify(payload, null, 2)}</pre>;
  const p: RequestPreviewPayload = parsed.data;
  const known = apps?.find((x) => x.id === p.appId);
  const color = appColors((apps ?? []).map((x) => x.id).concat(known ? [] : [p.appId])).get(p.appId) ?? "biru";
  const outcome = releaseOutcome(a);
  const maxLines = Math.max(0, ...p.files.map((x) => x.added + x.removed));
  const totals = p.files.reduce((s, x) => ({ added: s.added + x.added, removed: s.removed + x.removed }), { added: 0, removed: 0 });
  const host = p.url.replace(/^https?:\/\//, "");
  const m = p.manifest;

  return (
    <div className="overflow-hidden rounded-xl border bg-background text-sm" style={signVars(color)}>
      {/* the shopfront: the app's sign over its address */}
      <div className="relative space-y-2.5 border-b bg-[color-mix(in_srgb,var(--sign)_7%,transparent)] px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AppSign app={{ name: p.appName, status: known?.preview.status ?? "running" }} color={color} />
          {p.currentCommit ? (
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("preview.update")}</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--sign)] px-2 py-0.5 text-[11px] font-semibold tracking-wide text-[var(--sign-ink)] uppercase">
              <Sparkles className="size-3" aria-hidden /> {t("preview.firstPreview")}
            </span>
          )}
        </div>
        <a
          href={p.url.startsWith("https://") ? p.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-2 rounded-lg border-2 border-dashed bg-background/70 px-3 py-1.5 font-mono text-xs font-semibold transition-colors hover:border-foreground/50"
        >
          <span className="min-w-0 truncate">{host}</span>
          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">{t("preview.openApp")}</span>
        </a>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Server className="size-3.5" aria-hidden /> {t("preview.server")}
          </dt>
          <dd className="font-medium">{p.serverName}</dd>
          <dt className="flex items-center gap-1 text-muted-foreground">
            <GitBranch className="size-3.5" aria-hidden /> {t("preview.branch")}
          </dt>
          <dd className="min-w-0 truncate">
            <code className="font-mono">{p.branch}</code> <span className="text-muted-foreground">· {p.repository}</span>
          </dd>
        </dl>
      </div>

      <div className="space-y-4 px-4 py-3">
        {/* the swap: what runs now → what will run */}
        <div className="flex flex-wrap items-center gap-2">
          {p.currentCommit ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("preview.runsNow")} <CommitChip sha={p.currentCommit} />
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("preview.nothingRuns")}</span>
          )}
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <CommitChip sha={p.commit} className="bg-[color-mix(in_srgb,var(--sign)_18%,transparent)] text-foreground" />
            {p.commitSubject && <span className="min-w-0 truncate font-medium">{p.commitSubject}</span>}
          </span>
        </div>

        {p.summary && (
          <blockquote className="border-l-4 border-[var(--sign)] bg-muted/30 py-2 pr-3 pl-3 whitespace-pre-wrap break-words">
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

        {/* what wfos-app.json asks of the server */}
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("preview.manifest")}</h4>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5", m.database && "border-[var(--sign)]/50 bg-[color-mix(in_srgb,var(--sign)_10%,transparent)]")}>
              <Database className="size-3.5" aria-hidden /> {m.database ? t("preview.databaseYes") : t("preview.databaseNo")}
            </span>
            <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5", m.migrate && "border-[var(--sign)]/50 bg-[color-mix(in_srgb,var(--sign)_10%,transparent)]")}>
              <DatabaseZap className="size-3.5" aria-hidden /> {m.migrate ? t("preview.migrateYes") : t("preview.migrateNo")}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
              <HardDrive className="size-3.5" aria-hidden /> {t("preview.memory", { mb: m.memoryMb })}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
              <HeartPulse className="size-3.5" aria-hidden /> <code className="font-mono">{m.health}</code>
            </span>
          </div>
          {m.migrate && (
            <div className="text-xs text-muted-foreground">
              {t("preview.migrateCommand")} <code className="rounded bg-muted px-1 font-mono">{m.migrate}</code>
            </div>
          )}
        </section>

        {p.commits.length > 0 && (
          <section className="space-y-1">
            <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {p.currentCommit ? t("preview.commitsSince", { count: p.commits.length }) : t("preview.commitsFirst", { count: p.commits.length })}
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

        <p className="text-xs text-muted-foreground">{t("preview.howItRuns", { commit: p.commit.slice(0, 7) })}</p>
      </div>
    </div>
  );
}
