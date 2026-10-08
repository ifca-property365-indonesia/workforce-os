"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { WORKSPACE_BUILTIN_TOOLS } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

type Bi = { en: string; id: string };
interface Subagent {
  name: string;
  description: Bi;
  prompt: Bi;
  tools?: string[];
}
interface Department {
  key: string;
  name: Bi;
  sop: Bi;
  subagents: Subagent[];
}

/** Two text areas side by side: Bahasa Indonesia and English. */
function BilingualField({ label, value, onChange, rows = 4, disabled }: { label: string; value: Bi; onChange: (v: Bi) => void; rows?: number; disabled?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(["id", "en"] as const).map((l) => (
        <div key={l} className="space-y-1">
          <Label className="text-xs">
            {label} · {l.toUpperCase()}
          </Label>
          <Textarea rows={rows} value={value[l]} disabled={disabled} onChange={(e) => onChange({ ...value, [l]: e.target.value })} className="text-xs" />
        </div>
      ))}
    </div>
  );
}

function DepartmentEditor({ dept, admin }: { dept: Department; admin: boolean }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const [d, setD] = useState(dept);
  useEffect(() => setD(dept), [dept]);
  const save = useMutation({
    mutationFn: () => api.put(`/api/departments/${dept.key}`, { name: d.name, sop: d.sop, subagents: d.subagents }),
    onSuccess: () => {
      toast.success(t("departments.saved"));
      void qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const setSub = (i: number, s: Subagent) => setD({ ...d, subagents: d.subagents.map((x, k) => (k === i ? s : x)) });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {d.name.id} / {d.name.en}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <BilingualField label={t("departments.sop")} value={d.sop} rows={8} disabled={!admin} onChange={(sop) => setD({ ...d, sop })} />
        <div className="space-y-3">
          <div className="text-sm font-medium">{t("departments.subagents")}</div>
          {!d.subagents.length && <p className="text-xs text-muted-foreground">{t("departments.noSubagents")}</p>}
          {d.subagents.map((s, i) => (
            <div key={i} className="space-y-2 rounded-md border p-3">
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">{tc("name")}</Label>
                  <Input value={s.name} disabled={!admin} onChange={(e) => setSub(i, { ...s, name: e.target.value.toLowerCase() })} className="h-8 w-40 font-mono text-xs" />
                </div>
                {admin && (
                  <Button type="button" size="sm" variant="ghost" className="text-destructive" aria-label={tc("remove")} onClick={() => setD({ ...d, subagents: d.subagents.filter((_, k) => k !== i) })}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
              <BilingualField label={t("departments.description")} value={s.description} rows={2} disabled={!admin} onChange={(description) => setSub(i, { ...s, description })} />
              <BilingualField label={t("departments.prompt")} value={s.prompt} rows={4} disabled={!admin} onChange={(prompt) => setSub(i, { ...s, prompt })} />
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="text-muted-foreground">{t("departments.tools")}</span>
                {WORKSPACE_BUILTIN_TOOLS.map((tool) => (
                  <label key={tool} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      disabled={!admin}
                      checked={(s.tools ?? []).includes(tool)}
                      onChange={(e) => setSub(i, { ...s, tools: e.target.checked ? [...(s.tools ?? []), tool] : (s.tools ?? []).filter((x) => x !== tool) })}
                    />
                    <code>{tool}</code>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {admin && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => setD({ ...d, subagents: [...d.subagents, { name: "", description: { en: "", id: "" }, prompt: { en: "", id: "" }, tools: ["Read", "Grep", "Glob"] }] })}
            >
              <Plus className="size-3.5" /> {t("departments.addSubagent")}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">{t("departments.subagentsHelp")}</p>
        </div>
        {admin && (
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {tc("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Departments: bilingual SOPs and subagent definitions, per workspace. */
export function DepartmentsSettings({ admin }: { admin: boolean }) {
  const t = useTranslations("settings");
  const { data } = useQuery({ queryKey: ["departments"], queryFn: () => api.get<{ departments: Department[] }>("/api/departments").then((r) => r.departments) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("departments.title")}</CardTitle>
          <CardDescription>{t("departments.intro")}</CardDescription>
        </CardHeader>
      </Card>
      {data?.map((d) => (
        <DepartmentEditor key={d.key} dept={d} admin={admin} />
      ))}
    </div>
  );
}
