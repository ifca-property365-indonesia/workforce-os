"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Undo2, X } from "lucide-react";
import { APP_ENV_NAME_RE, APP_RESERVED_ENV, isForbiddenAppEnv, type AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { invalidateApp } from "./shared";

type Added = { key: number; name: string; value: string };

// i18n-ignore: an env name, the same in every language
const NAME_EXAMPLE = "SMTP_HOST";

/**
 * Write-only env: the names that exist are listed with their values hidden (the browser never has them). A new
 * value replaces one, an empty field keeps it; names can be removed or added. Saved as a merge (set + remove).
 */
export function EnvEditor({ app, admin }: { app: AppDTO; admin: boolean }) {
  const t = useTranslations("apps");
  const qc = useQueryClient();
  const uid = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Added[]>([]);

  const problems = added.map((a) => {
    const name = a.name.trim();
    if (!name) return null;
    if (!APP_ENV_NAME_RE.test(name)) return t("env.nameInvalid");
    if (isForbiddenAppEnv(name)) return t("env.nameReserved", { name });
    if (app.envKeys.includes(name) && !removed.has(name)) return t("env.nameDuplicate", { name });
    if (added.filter((b) => b.name.trim() === name).length > 1) return t("env.nameDuplicate", { name });
    return null;
  });
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v && !removed.has(k)) set[k] = v;
  for (const a of added) if (a.name.trim()) set[a.name.trim()] = a.value;
  const dirty = Object.keys(set).length > 0 || removed.size > 0;
  const valid = problems.every((p) => !p);

  const save = useMutation({
    mutationFn: () => api.put<{ envKeys: string[] }>(`/api/apps/${app.id}/env`, { set, remove: [...removed] }),
    onSuccess: () => {
      setValues({});
      setRemoved(new Set());
      setAdded([]);
      invalidateApp(qc, app.id);
      toast.success(t("env.saved"));
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t("env.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("env.description")}</p>
      </div>
      {!admin ? (
        app.envKeys.length ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t("env.readOnly")}</p>
            <ul className="flex flex-wrap gap-1.5">
              {app.envKeys.map((k) => (
                <li key={k}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("env.empty")}</p>
        )
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && valid) save.mutate();
          }}
        >
          {!app.envKeys.length && !added.length && <p className="text-sm text-muted-foreground">{t("env.empty")}</p>}
          {!!app.envKeys.length && (
            <ul className="divide-y rounded-lg border">
              {app.envKeys.map((k) => {
                const gone = removed.has(k);
                return (
                  <li key={k} className={cn("grid items-center gap-2 p-2 sm:grid-cols-[minmax(0,14rem)_1fr_auto]", gone && "bg-destructive/5")}>
                    <code className={cn("min-w-0 truncate font-mono text-xs font-semibold", gone && "text-destructive line-through")}>{k}</code>
                    {gone ? (
                      <span className="text-xs text-destructive">{t("env.removed")}</span>
                    ) : (
                      <Input
                        type="password"
                        autoComplete="off"
                        aria-label={`${k}: ${t("env.newValue")}`}
                        placeholder={`•••••• ${t("env.keep")}`}
                        value={values[k] ?? ""}
                        className="h-8 font-mono text-xs"
                        onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                      />
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8 justify-self-end"
                      aria-label={gone ? t("env.undo", { name: k }) : t("env.remove", { name: k })}
                      onClick={() => {
                        const next = new Set(removed);
                        if (gone) next.delete(k);
                        else next.add(k);
                        setRemoved(next);
                      }}
                    >
                      {gone ? <Undo2 className="size-3.5" /> : <X className="size-3.5" />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {added.map((a, i) => (
            <div key={a.key} className="space-y-1">
              <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
                <Input
                  aria-label={t("env.name")}
                  placeholder={NAME_EXAMPLE}
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={a.name}
                  aria-invalid={!!problems[i]}
                  aria-describedby={problems[i] ? `${uid}-p${a.key}` : undefined}
                  className="h-8 font-mono text-xs"
                  onChange={(e) => setAdded(added.map((b) => (b.key === a.key ? { ...b, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") } : b)))}
                />
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={t("env.value")}
                  value={a.value}
                  className="h-8 font-mono text-xs"
                  onChange={(e) => setAdded(added.map((b) => (b.key === a.key ? { ...b, value: e.target.value } : b)))}
                />
                <Button type="button" size="icon" variant="ghost" className="size-8 justify-self-end" aria-label={t("env.remove", { name: a.name || t("env.name") })} onClick={() => setAdded(added.filter((b) => b.key !== a.key))}>
                  <X className="size-3.5" />
                </Button>
              </div>
              {problems[i] && (
                <p id={`${uid}-p${a.key}`} className="text-xs text-destructive">
                  {problems[i]}
                </p>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setAdded([...added, { key: Date.now(), name: "", value: "" }])}>
              <Plus className="size-3.5" aria-hidden /> {t("env.add")}
            </Button>
            <Button size="sm" disabled={!dirty || !valid || save.isPending}>
              {t("env.save")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("env.reserved", { names: [...APP_RESERVED_ENV, "HOME", "PATH", "LD_*", "COREPACK_*"].join(", ") })}</p>
        </form>
      )}
    </section>
  );
}
