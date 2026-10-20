"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { History, RotateCcw } from "lucide-react";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { lineDiff } from "@/lib/doc-format";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

type Field =
  | "role"
  | "specialty"
  | "persona"
  | "instructions"
  | "businessContext"
  | "model"
  | "autonomyLevel"
  | "toolPermissions"
  | "allowList"
  | "dailyBudget"
  | "outputLanguage"
  | "executionMode"
  | "egressDomains"
  | "skillIds";
type Config = Record<Field, unknown> & { skills: (string | null)[] };
interface Revision {
  id: string;
  version: number;
  source: "baseline" | "person" | "replay" | "hr_auto" | "skills" | "skill_install" | "rollback";
  actorLabel: string;
  note: string;
  restoredVersion: number | null;
  createdAt: string;
  changed: Field[];
  config: Config;
}

/** the long text fields: shown as a line diff against the revision before */
const TEXT: Field[] = ["instructions", "persona", "businessContext"];

/** a short, readable value of a non-text field */
function short(field: Field, c: Config): string {
  if (field === "skillIds") return c.skills.map((s) => s ?? "—").join(", ") || "—";
  if (field === "toolPermissions") return String((c.toolPermissions as { enabled: boolean }[]).filter((p) => p.enabled).length);
  if (field === "allowList" || field === "egressDomains") return String((c[field] as unknown[]).length);
  const v = c[field];
  return v === "" || v === null || v === undefined ? "—" : String(v);
}

/**
 * P2: the employee's configuration history. Every change (a person, an HR replay, skills) is a version; a version shows
 * what it changed against the one before, and an Admin restores it (the same checks as an edit).
 */
export function RevisionsPanel({ employeeId, admin }: { employeeId: string; admin: boolean }) {
  const t = useTranslations("employees.revisions");
  const f = useFormat();
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const [open, setOpen] = useState<number | null>(null);
  const { data } = useQuery({ queryKey: ["employee-revisions", employeeId], queryFn: () => api.get<{ revisions: Revision[] }>(`/api/employees/${employeeId}/revisions`) });
  const restore = useMutation({
    mutationFn: (version: number) => withStepUp(() => api.post<{ ok: true; missingSkills: number }>(`/api/employees/${employeeId}/revisions/${version}`, { action: "restore" })),
    onSuccess: (r) => {
      if (!r) return;
      toast.success(r.missingSkills ? t("restoredMissing", { count: r.missingSkills }) : t("restored"));
      for (const k of [["employee-revisions", employeeId], ["employee", employeeId], ["employee-skills", employeeId]]) void qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const revs = data?.revisions ?? [];
  return (
    <section className="space-y-3" aria-labelledby="revisions-title">
      <h2 id="revisions-title" className="flex items-center gap-2 text-base font-semibold">
        <History className="size-4" aria-hidden /> {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {!revs.length && <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t("empty")}</p>}
      <ol className="space-y-2">
        {revs.map((r, i) => {
          const prev = revs[i + 1];
          const current = i === 0;
          return (
            <li key={r.id} className="rounded-xl border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums">{t("version", { version: r.version })}</span>
                <span className="rounded bg-secondary px-1.5 text-xs">{t(`source.${r.source}`, { version: r.restoredVersion ?? 0 })}</span>
                {current && <span className="rounded bg-success/15 px-1.5 text-xs text-success">{t("current")}</span>}
                <span className="text-xs text-muted-foreground">{[r.actorLabel, f.ago(r.createdAt)].filter(Boolean).join(" · ")}</span>
                <span className="ml-auto flex gap-1">
                  {!!r.changed.length && prev && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={open === r.version} onClick={() => setOpen(open === r.version ? null : r.version)}>
                      {open === r.version ? t("hide") : t("show")}
                    </Button>
                  )}
                  {admin && !current && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={restore.isPending}
                      onClick={() => confirm(t("restoreConfirm", { version: r.version })) && restore.mutate(r.version)}
                    >
                      <RotateCcw className="size-3" aria-hidden /> {t("restore")}
                    </Button>
                  )}
                </span>
              </div>
              {!!r.changed.length && <p className="mt-1 text-xs text-muted-foreground">{t("changed", { fields: r.changed.map((x) => t(`field.${x}`)).join(", ") })}</p>}
              {r.note && <p className="mt-1 text-xs text-muted-foreground">{r.note}</p>}
              {open === r.version && prev && (
                <div className="mt-2 space-y-2">
                  {r.changed.map((field) =>
                    TEXT.includes(field) ? (
                      <div key={field}>
                        <p className="text-xs font-medium">{t(`field.${field}`)}</p>
                        <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">
                          {lineDiff(String(prev.config[field] ?? ""), String(r.config[field] ?? "")).map((l, j) => (
                            <span key={j} className={cn("block", l.op === "add" && "bg-success/15", l.op === "del" && "bg-destructive/15 line-through opacity-80")}>
                              {l.op === "add" ? "+ " : l.op === "del" ? "− " : "  "}
                              {l.text}
                            </span>
                          ))}
                        </pre>
                      </div>
                    ) : (
                      <p key={field} className="text-xs">
                        <span className="font-medium">{t(`field.${field}`)}:</span> <span className="text-muted-foreground line-through">{short(field, prev.config)}</span> → {short(field, r.config)}
                      </p>
                    ),
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
