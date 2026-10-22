"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Loader2, PlugZap } from "lucide-react";
import type { ClaudeLoginState } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";

type Reply = { login: ClaudeLoginState | null };
const KEY = ["claude-login"];
const waiting = (l: ClaudeLoginState | null | undefined) => l?.status === "starting" || l?.status === "awaiting_code" || l?.status === "verifying";

/**
 * Connect Claude (after AIRIS 8314578): the server runs `claude setup-token` for this workspace, the Owner signs in at
 * claude.com and pastes the code it shows; the token is stored server-side and never reaches the browser.
 */
export function ClaudeConnect({ hasCredential, onConnected }: { hasCredential: boolean; onConnected: () => void }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const [code, setCode] = useState("");
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<Reply>("/api/settings/claude/connect"),
    refetchInterval: (q) => (waiting(q.state.data?.login) ? 1500 : false),
  });
  const login = data?.login ?? null;

  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (login?.status !== "connected" || announced.current === login.id) return;
    announced.current = login.id;
    toast.success(t("claude.connect.connectedToast", { last4: login.last4 ?? "" }));
    onConnected();
  }, [login, onConnected, t]);

  const onError = (e: unknown) => toast.error((e as Error).message);
  const put = (r: Reply | undefined) => r && qc.setQueryData(KEY, r);
  const start = useMutation({
    mutationFn: () => withStepUp(() => api.post<Reply>("/api/settings/claude/connect")),
    onSuccess: (r) => {
      setCode("");
      put(r);
    },
    onError,
  });
  const send = useMutation({
    mutationFn: () => withStepUp(() => api.post<Reply>("/api/settings/claude/connect/code", { sessionId: login!.id, code: code.trim() })),
    onSuccess: put,
    onError,
  });
  const cancel = useMutation({ mutationFn: () => api.del<Reply>("/api/settings/claude/connect"), onSuccess: put, onError });

  const cancelButton = (
    <Button type="button" variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
      {tc("cancel")}
    </Button>
  );

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <div className="font-medium">{t("claude.connect.title")}</div>
        <p className="text-muted-foreground">{t("claude.connect.help")}</p>
      </div>

      {login?.status === "failed" && login.error && (
        <Alert variant="destructive">
          <AlertDescription>{t(`claude.connect.error.${login.error}`)}</AlertDescription>
        </Alert>
      )}

      {!waiting(login) && (
        <Button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          {hasCredential ? t("claude.connect.reconnect") : t("claude.connect.start")}
        </Button>
      )}

      {login?.status === "starting" && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("claude.connect.starting")}
          {cancelButton}
        </div>
      )}

      {login?.status === "awaiting_code" && login.url && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <ol className="list-decimal space-y-3 pl-5">
            <li className="space-y-1.5">
              <div>{t("claude.connect.step1")}</div>
              <Button asChild variant="outline" size="sm">
                <a href={login.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                  {t("claude.connect.openLink")}
                </a>
              </Button>
            </li>
            <li className="space-y-1.5">
              <Label htmlFor="claude-login-code">{t("claude.connect.step2")}</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="claude-login-code"
                  className="min-w-0 flex-1 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t("claude.connect.codeLabel")}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button disabled={code.trim().length < 10 || send.isPending}>{t("claude.connect.submit")}</Button>
                {cancelButton}
              </div>
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">{t("claude.connect.expires", { time: f.time(login.expiresAt) })}</p>
        </form>
      )}

      {login?.status === "verifying" && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("claude.connect.verifying")}
        </div>
      )}
    </div>
  );
}
