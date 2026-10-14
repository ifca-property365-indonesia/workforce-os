"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleCheck, CircleDashed, CircleX, Copy, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { AppDTO, AppEnvironmentDTO, DomainCheck, DomainCheckStatus } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { copyText, invalidateApp } from "./shared";

const TONE: Record<DomainCheckStatus, string> = {
  ok: "bg-success/15 text-success",
  wrong: "bg-destructive/15 text-destructive",
  missing: "bg-warning/20 text-warning",
  error: "bg-muted text-muted-foreground",
};
const ICON: Record<DomainCheckStatus, typeof CircleCheck> = { ok: CircleCheck, wrong: CircleX, missing: CircleDashed, error: TriangleAlert };

export function DnsStatusChip({ status, className }: { status: DomainCheckStatus | null; className?: string }) {
  const t = useTranslations("apps");
  const Icon = status ? ICON[status] : CircleDashed;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", status ? TONE[status] : "bg-muted text-muted-foreground", className)}>
      <Icon className="size-3" aria-hidden />
      {t(`dns.status.${status ?? "unchecked"}`)}
    </span>
  );
}

/** "A" for an IPv4 address, "AAAA" for IPv6 */
const recordType = (ip: string) => (ip.includes(":") ? "AAAA" : "A");

/**
 * The live domain's DNS: the records the client creates at their DNS provider (every name → the server's address,
 * copyable), the last check per name, and "Check DNS". A live release waits for ok; the certificate is asked for
 * at the first release, for all names at once.
 */
export function DnsPanel({ app, env, admin }: { app: Pick<AppDTO, "id">; env: AppEnvironmentDTO; admin: boolean }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => api.post<{ dnsCheck: DomainCheck }>(`/api/apps/${app.id}/live/dns-check`),
    onSuccess: (r) => {
      invalidateApp(qc, app.id);
      if (r.dnsCheck.status === "ok") toast.success(t("dns.okToast"));
      else toast.message(t(`dns.summary.${r.dnsCheck.status}`));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const dns = env.dnsCheck;
  const names = [env.domain, ...env.extraDomains];
  const expected = dns?.expected ?? [];
  const result = (name: string) => dns?.names.find((n) => n.name === name);

  return (
    <section className="space-y-3 rounded-xl border border-[var(--sign-merah)]/30 bg-card p-4" aria-labelledby={`dns-${env.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={`dns-${env.id}`} className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {t("dns.title")} <DnsStatusChip status={dns?.status ?? null} />
          </h2>
          <p className="max-w-[70ch] text-sm text-muted-foreground">{dns?.status === "ok" ? t("dns.okHelp") : t("dns.help")}</p>
        </div>
        {admin && (
          <Button type="button" size="sm" variant={dns?.status === "ok" ? "outline" : "default"} className="gap-1.5" disabled={check.isPending} onClick={() => check.mutate()}>
            <RefreshCw className={cn("size-3.5", check.isPending && "animate-spin motion-reduce:animate-none")} aria-hidden /> {check.isPending ? t("dns.checking") : t("dns.check")}
          </Button>
        )}
      </div>

      {expected.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("dns.columns.type")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("dns.columns.name")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("dns.columns.value")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("dns.columns.now")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {names.flatMap((name) => {
                const r = result(name);
                return expected.map((ip, i) => (
                  <tr key={`${name}-${ip}`} className="align-top">
                    <td className="px-3 py-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">{recordType(ip)}</code>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex max-w-full items-center gap-1">
                        <code className="min-w-0 truncate font-mono text-xs font-semibold">{name}</code>
                        <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" aria-label={t("dns.copyName", { name })} onClick={() => void copyText(name, tc("copied"), toast)}>
                          <Copy className="size-3" />
                        </Button>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5">
                        <code className="font-mono text-xs font-semibold">{ip}</code>
                        <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" aria-label={t("dns.copyValue", { value: ip })} onClick={() => void copyText(ip, tc("copied"), toast)}>
                          <Copy className="size-3" />
                        </Button>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {i === 0 && (
                        <div className="space-y-1">
                          <DnsStatusChip status={r?.status ?? null} />
                          {r && r.found.length > 0 && r.status !== "ok" && (
                            <p className="font-mono text-[11px] text-muted-foreground">{t("dns.found", { addresses: r.found.join(", ") })}</p>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{dns ? t("dns.noServerAddress") : t("dns.notChecked")}</p>
      )}

      <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
        <p className="flex max-w-[70ch] gap-1.5">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            {env.extraDomains.length
              ? t("dns.certificateWithAliases", { domain: env.domain, aliases: env.extraDomains.join(", ") })
              : t("dns.certificate", { domain: env.domain })}
          </span>
        </p>
        {dns && (
          <time className="shrink-0" dateTime={dns.checkedAt} title={f.dateTime(dns.checkedAt)}>
            {t("dns.checkedAgo", { ago: f.ago(dns.checkedAt) })}
          </time>
        )}
      </div>
    </section>
  );
}
