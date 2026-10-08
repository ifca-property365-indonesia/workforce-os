"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
const StepUpContext = createContext<Run | null>(null);

/**
 * Wraps a sensitive request: when the server answers `step_up_required`, ask for password + authenticator code,
 * confirm with /api/me/reauth (valid 10 minutes) and retry the request once.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: (ok: boolean) => void } | null>(null);

  const ask = () =>
    new Promise<boolean>((resolve) => {
      pending.current = { resolve };
      setPassword("");
      setCode("");
      setOpen(true);
    });

  const run: Run = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      const code = e instanceof ApiError ? (e.data as { code?: string } | undefined)?.code : undefined;
      if (code === "two_factor_required") {
        toast.error(t("stepUp.needs2fa"));
        return undefined;
      }
      if (code !== "step_up_required") throw e;
      if (!(await ask())) return undefined;
      return fn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    pending.current?.resolve(ok);
    pending.current = null;
  };

  return (
    <StepUpContext.Provider value={run}>
      {children}
      <Dialog open={open} onOpenChange={(o) => !o && finish(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("stepUp.title")}</DialogTitle>
            <DialogDescription>{t("stepUp.description")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.post("/api/me/reauth", { password: password || undefined, code });
                finish(true);
              } catch (err) {
                toast.error((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="stepup-password">{tc("password")}</Label>
              <Input id="stepup-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="max-w-40 space-y-1.5">
              <Label htmlFor="stepup-code">{t("twoFactor.authenticatorCode")}</Label>
              <Input id="stepup-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => finish(false)}>
                {tc("cancel")}
              </Button>
              <Button disabled={busy || code.length !== 6}>{t("stepUp.confirm")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): Run {
  const run = useContext(StepUpContext);
  if (!run) throw new Error("useStepUp needs <StepUpProvider>");
  return run;
}
