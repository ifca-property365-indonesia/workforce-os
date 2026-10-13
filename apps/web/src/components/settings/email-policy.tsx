"use client";

import Link from "@/lib/nav";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUpRight, PauseCircle } from "lucide-react";
import { SMTP_PRESETS, type EmailPolicy, type SmtpPresetKey } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useOutboxStats } from "@/components/outbox/parts";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type SmtpShape = { host: string; port: number; secure: boolean };

/** The preset these settings match (host and port), if any. */
export function smtpPresetOf(f: SmtpShape) {
  return SMTP_PRESETS.find((p) => p.host === f.host && p.port === f.port);
}

/**
 * Provider presets: picking one fills host, port and TLS (465 implicit TLS, 587 STARTTLS); "Other" leaves the fields
 * as they are for a server that is not listed.
 */
export function SmtpPresetPicker({ value, onPick }: { value: SmtpShape; onPick: (v: SmtpShape) => void }) {
  const t = useTranslations("settings");
  const current = smtpPresetOf(value)?.key ?? "other";
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label htmlFor="smtp-preset">{t("email.preset")}</Label>
      <select
        id="smtp-preset"
        className="h-9 w-full rounded-md border bg-background px-2 text-sm sm:max-w-72"
        value={current}
        onChange={(e) => {
          const p = SMTP_PRESETS.find((x) => x.key === e.target.value);
          if (p) onPick({ host: p.host, port: p.port, secure: p.secure });
        }}
      >
        {SMTP_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {t(`email.presets.${p.key}`)}
          </option>
        ))}
        <option value="other">{t("email.presets.other")}</option>
      </select>
      <p className="text-xs text-muted-foreground">{t("email.presetHelp")}</p>
    </div>
  );
}

/** Placeholder for the SMTP user field when a preset is picked (what that provider expects as the user name). */
export function useSmtpUserHint(f: SmtpShape): string | undefined {
  const t = useTranslations("settings");
  const key: SmtpPresetKey | undefined = smtpPresetOf(f)?.key;
  return key ? t(`email.presetUser.${key}`) : undefined;
}

/** Today's outgoing mail at a glance, linking to the outbox. */
function OutboxStatus() {
  const t = useTranslations("settings");
  const { data } = useOutboxStats();
  const cells = [
    { key: "sent", label: t("emailPolicy.sentToday"), value: data ? `${data.sentToday} / ${data.dailyLimit}` : "…", tone: "" },
    { key: "failed", label: t("emailPolicy.failedToday"), value: data?.failedToday ?? "…", tone: data?.failedToday ? "text-destructive" : "" },
    { key: "pending", label: t("emailPolicy.waiting"), value: data?.pending ?? "…", tone: "" },
  ];
  return (
    <div className="self-start overflow-hidden rounded-xl border">
      <div className="grid grid-cols-3">
        {cells.map((c, i) => (
          <div key={c.key} className={cn("min-w-0 p-3", i > 0 && "border-l")}>
            <div className="truncate text-xs text-muted-foreground">{c.label}</div>
            <div className={cn("font-display mt-1 text-[1.6rem] tabular-nums", c.tone)}>{c.value}</div>
          </div>
        ))}
      </div>
      <Link href="/outbox" className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-secondary/60 hover:text-foreground">
        {t("emailPolicy.openOutbox")} <ArrowUpRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

/** Outgoing agent email: pause everything, or cap how many go out per day. Notifications are not affected. */
export function EmailPolicySettings() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["email-policy"], queryFn: () => api.get<{ policy: EmailPolicy }>("/api/settings/email-policy").then((r) => r.policy) });
  const [limit, setLimit] = useState("");
  useEffect(() => {
    if (data) setLimit(String(data.dailyLimit));
  }, [data]);
  const save = useMutation({
    mutationFn: (patch: Partial<EmailPolicy>) => api.put<{ policy: EmailPolicy }>("/api/settings/email-policy", patch),
    onSuccess: (r) => {
      qc.setQueryData(["email-policy"], r.policy);
      void qc.invalidateQueries({ queryKey: ["outbox"] });
      toast.success(r.policy.paused ? t("emailPolicy.pausedToast") : t("emailPolicy.savedToast"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const n = Number(limit);
  const validLimit = Number.isInteger(n) && n >= 1 && n <= 10000;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("emailPolicy.title")}</CardTitle>
        <CardDescription>{t("emailPolicy.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <label className={cn("flex items-start gap-3 rounded-xl border p-3", data?.paused && "border-warning/50 bg-warning/10")}>
            <Switch className="mt-0.5" checked={!!data?.paused} disabled={!data || save.isPending} onCheckedChange={(v) => save.mutate({ paused: v })} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {data?.paused && <PauseCircle className="size-4 text-warning" aria-hidden />}
                {t("emailPolicy.pause")}
              </span>
              <span className="block text-xs text-muted-foreground">{t("emailPolicy.pauseHelp")}</span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="email-daily-limit">{t("emailPolicy.dailyLimit")}</Label>
            <div className="flex gap-2">
              <Input id="email-daily-limit" type="number" min={1} max={10000} className="max-w-32" value={limit} onChange={(e) => setLimit(e.target.value)} aria-invalid={!validLimit} />
              <Button variant="outline" onClick={() => save.mutate({ dailyLimit: n })} disabled={!data || !validLimit || n === data.dailyLimit || save.isPending}>
                {tc("save")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("emailPolicy.dailyLimitHelp")}</p>
          </div>
        </div>
        <OutboxStatus />
      </CardContent>
    </Card>
  );
}
