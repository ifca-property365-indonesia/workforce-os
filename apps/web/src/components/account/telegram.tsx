"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";

/** Account → Telegram: link a chat with a one-time code, or unlink it. */
export function TelegramCard() {
  const t = useTranslations("account");
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [link, setLink] = useState<{ code: string; bot: string | null } | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<{ code: string; bot: string | null }>("/api/me/telegram"),
    onSuccess: setLink,
    onError: (e) => toast.error((e as Error).message),
  });
  const unlink = useMutation({
    mutationFn: () => api.del("/api/me/telegram"),
    onSuccess: () => {
      setLink(null);
      toast.success(t("telegram.unlinked"));
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!me || !me.telegramEnabled) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("telegram.title")}</CardTitle>
        <CardDescription>{t("telegram.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {me.user.telegramLinked ? (
          <>
            <p>{t("telegram.linked")}</p>
            <Button variant="outline" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              {t("telegram.unlink")}
            </Button>
          </>
        ) : link ? (
          <>
            <p>{link.bot ? t("telegram.sendToBot", { bot: `@${link.bot}` }) : t("telegram.sendToTheBot")}</p>
            {/* i18n-ignore: bot command */}
            <code className="block rounded-md bg-muted p-3 font-mono text-base">/link {link.code}</code>
            <p className="text-xs text-muted-foreground">{t("telegram.expires")}</p>
            <Button variant="outline" onClick={() => void qc.invalidateQueries({ queryKey: ["me"] })}>
              {t("telegram.check")}
            </Button>
          </>
        ) : (
          <Button disabled={start.isPending} onClick={() => start.mutate()}>
            {t("telegram.link")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
