"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, Globe, KeyRound, RefreshCw } from "lucide-react";
import type { AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { copyText } from "./shared";

// i18n-ignore: the basic-auth user name, the same in every language
const PREVIEW_USER = "preview";

interface Access {
  username: string;
  password: string;
}

/**
 * The preview's login. The password is fetched only when an Admin asks to see it (each view is audited) and is kept
 * in this component's memory, never in the query cache.
 */
export function AccessCard({ app, admin }: { app: AppDTO; admin: boolean }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const [shown, setShown] = useState<Access | null>(null);
  const reveal = useMutation({
    mutationFn: () => api.get<Access>(`/api/apps/${app.id}/access`),
    onSuccess: setShown,
    onError: (e) => toast.error((e as Error).message),
  });
  const rotate = useMutation({
    mutationFn: () => api.post<Access>(`/api/apps/${app.id}/access`),
    onSuccess: (r) => {
      setShown(r);
      toast.success(t("access.rotated"));
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (app.accessMode === "public")
    return (
      <section className="flex gap-3 rounded-xl border bg-card p-4">
        <Globe className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">{t("access.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("access.public")}</p>
        </div>
      </section>
    );

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">{t("access.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("access.description")}</p>
        </div>
      </div>
      {admin && (
        <>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-lg bg-muted/50 p-3 text-sm">
            <dt className="text-xs text-muted-foreground">{t("access.username")}</dt>
            <dd className="font-mono font-semibold">{shown?.username ?? PREVIEW_USER}</dd>
            <dt className="text-xs text-muted-foreground">{t("access.password")}</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono font-semibold tracking-wide" aria-live="polite">
                {shown ? shown.password : "•".repeat(16)}
              </span>
              {shown && (
                <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={tc("copy")} onClick={() => void copyText(shown.password, tc("copied"), toast)}>
                  <Copy className="size-3.5" />
                </Button>
              )}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            {shown ? (
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setShown(null)}>
                <EyeOff className="size-3.5" aria-hidden /> {t("access.hide")}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
                <Eye className="size-3.5" aria-hidden /> {t("access.reveal")}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" className="gap-1.5" disabled={rotate.isPending} onClick={() => confirm(t("access.rotateConfirm")) && rotate.mutate()}>
              <RefreshCw className="size-3.5" aria-hidden /> {t("access.rotate")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("access.audited")}</p>
        </>
      )}
    </section>
  );
}
