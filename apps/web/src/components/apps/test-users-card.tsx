"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, Plus, Trash2, UsersRound } from "lucide-react";
import type { AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { copyText } from "./shared";

interface TestUserRow {
  role: string;
  label: string;
  username: string;
  loginPath: string;
  source: "auto" | "manual";
  viewAll: boolean;
  note: string;
  hasTotp: boolean;
  ownPassword: boolean;
}
interface TestUsersResponse {
  users: TestUserRow[];
  lastRunAt: string | null;
  lastRunNote: string | null;
  sharedPassword: boolean;
}
interface Revealed {
  username: string;
  password: string;
  code: string | null;
  codeValidFor: number | null;
}

/**
 * C10: the preview's test accounts per role, from the app's testUsers script (wfos-app.json) after each preview
 * release, or added by hand. Admins can show one's password and the two-factor code valid now (audited); the
 * revealed values live in this component only, never in the query cache.
 */
export function TestUsersCard({ app, admin }: { app: Pick<AppDTO, "id">; admin: boolean }) {
  const t = useTranslations("apps.testUsers");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const key = ["app", app.id, "test-users"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<TestUsersResponse>(`/api/apps/${app.id}/test-users`) });
  const [shown, setShown] = useState<Record<string, Revealed>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ role: "", label: "", username: "", password: "", loginPath: "/" });

  // a shown code expires: hide it with its 30-second step
  useEffect(() => {
    const ttl = Math.min(...Object.values(shown).map((r) => r.codeValidFor ?? 120));
    if (!Number.isFinite(ttl)) return;
    const id = setTimeout(() => setShown({}), ttl * 1000);
    return () => clearTimeout(id);
  }, [shown]);

  const reveal = useMutation({
    mutationFn: (role: string) => api.post<Revealed>(`/api/apps/${app.id}/test-users/reveal`, { role }).then((r) => ({ role, r })),
    onSuccess: ({ role, r }) => setShown((s) => ({ ...s, [role]: r })),
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (role: string) => api.del(`/api/apps/${app.id}/test-users?role=${encodeURIComponent(role)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error((e as Error).message),
  });
  const add = useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${app.id}/test-users`, {
        role: form.role.trim(),
        label: form.label.trim() || form.role.trim(),
        username: form.username.trim(),
        loginPath: form.loginPath.trim() || "/",
        ...(form.password ? { password: form.password } : {}),
      }),
    onSuccess: () => {
      toast.success(t("added"));
      setAdding(false);
      setForm({ role: "", label: "", username: "", password: "", loginPath: "/" });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const users = data?.users ?? [];
  const failed = data?.lastRunNote?.startsWith("failed: ");
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <UsersRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          {data?.lastRunAt && (
            <p className={failed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {t("lastRun", { when: f.ago(data.lastRunAt) })}
              {data.lastRunNote ? ` · ${data.lastRunNote}` : ""}
            </p>
          )}
        </div>
      </div>
      {!users.length && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">{t("empty")}</p>}
      {!!users.length && (
        <ul className="divide-y rounded-lg border">
          {users.map((u) => {
            const s = shown[u.role];
            return (
              <li key={u.role} className="space-y-1.5 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold">{u.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{u.role}</span>
                  {u.viewAll && <span className="rounded bg-secondary px-1.5 text-[11px] font-semibold">{t("viewAll")}</span>}
                  {u.hasTotp && <span className="rounded bg-secondary px-1.5 text-[11px] font-semibold">{t("twoFactor")}</span>}
                  <span className="text-[11px] text-muted-foreground">{t(`source.${u.source}`)}</span>
                </div>
                <div className="flex min-w-0 items-center gap-1 font-mono text-xs">
                  <span className="min-w-0 truncate">{u.username}</span>
                  <span className="shrink-0 text-muted-foreground">· {u.loginPath}</span>
                </div>
                {s && (
                  <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 p-2 text-xs" aria-live="polite">
                    <dt className="text-muted-foreground">{t("password")}</dt>
                    <dd className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 flex-1 truncate font-mono font-semibold">{s.password}</span>
                      <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={tc("copy")} onClick={() => void copyText(s.password, tc("copied"), toast)}>
                        <Copy className="size-3" />
                      </Button>
                    </dd>
                    {s.code && (
                      <>
                        <dt className="text-muted-foreground">{t("code")}</dt>
                        <dd className="font-mono font-semibold tracking-widest">
                          {s.code} <span className="font-sans font-normal tracking-normal text-muted-foreground">{t("codeValid", { seconds: s.codeValidFor ?? 0 })}</span>
                        </dd>
                      </>
                    )}
                  </dl>
                )}
                {admin && (
                  <div className="flex gap-1.5">
                    {s ? (
                      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setShown(({ [u.role]: _, ...rest }) => rest)}>
                        <EyeOff className="size-3" aria-hidden /> {t("hide")}
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={reveal.isPending} onClick={() => reveal.mutate(u.role)}>
                        <Eye className="size-3" aria-hidden /> {t("reveal")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={remove.isPending}
                      onClick={() => confirm(t(u.source === "auto" ? "removeAutoConfirm" : "removeConfirm", { label: u.label })) && remove.mutate(u.role)}
                    >
                      <Trash2 className="size-3" aria-hidden /> {t("remove")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {admin && !adding && (
        <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" aria-hidden /> {t("add")}
        </Button>
      )}
      {admin && adding && (
        <form
          className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          {(
            [
              ["role", t("fields.role"), "approver"],
              ["label", t("fields.label"), "Approver"],
              ["username", t("fields.username"), "approver@example.test"],
              ["loginPath", t("fields.loginPath"), "/login"],
            ] as const
          ).map(([k, label, ph]) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`tu-${k}`} className="text-xs">
                {label}
              </Label>
              <Input id={`tu-${k}`} value={form[k]} placeholder={ph} onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value }))} required={k === "role" || k === "username"} />
            </div>
          ))}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="tu-password" className="text-xs">
              {t("fields.password")}
            </Label>
            <Input id="tu-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm((x) => ({ ...x, password: e.target.value }))} required={!data?.sharedPassword} />
            <p className="text-xs text-muted-foreground">{data?.sharedPassword ? t("fields.passwordShared") : t("fields.passwordNeeded")}</p>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={add.isPending}>
              {t("save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {tc("cancel")}
            </Button>
          </div>
        </form>
      )}
      <p className="text-xs text-muted-foreground">{t("audited")}</p>
    </section>
  );
}
