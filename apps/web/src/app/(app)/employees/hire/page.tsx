"use client";

import { useStepUp } from "@/components/account/step-up";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { DEFAULT_MODEL, OUTPUT_LANGUAGES, type AutonomyLevel, type OutputLanguage, type ToolPermission } from "@wfos/shared";
import type { RoleTemplate } from "@wfos/templates";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, PageHeader } from "@/components/layout/common";
import { AutonomyPicker, ToolPermissionsEditor } from "@/components/employees/tool-permissions";
import { TaskDetail } from "@/components/inspector/task-detail";
import { api } from "@/lib/api";
import { useTemplates, type Employee } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

const STEPS = ["template", "persona", "tools", "firstTask"] as const;
const EMOJIS = ["🤖", "👩‍💻", "🧭", "🧾", "🎧", "📣", "🔎", "🧪", "🦉", "🛠️", "📊", "✍️"];

interface Draft {
  templateKey: string | null;
  name: string;
  avatar: string;
  role: string;
  persona: string;
  instructions: string;
  businessContext: string;
  model: string;
  autonomyLevel: AutonomyLevel;
  toolPermissions: ToolPermission[];
  dailyBudget: number;
  outputLanguage: OutputLanguage;
  executionMode: "tool" | "workspace";
  egressDomains: string[];
}

const blank: Draft = {
  templateKey: null,
  name: "",
  avatar: "🤖",
  role: "",
  persona: "",
  instructions: "",
  businessContext: "",
  model: DEFAULT_MODEL,
  autonomyLevel: "DRAFT",
  toolPermissions: [],
  dailyBudget: 200,
  outputLanguage: "inherit",
  executionMode: "tool",
  egressDomains: [],
};

function fromTemplate(t: RoleTemplate): Draft {
  return {
    ...blank,
    templateKey: t.key,
    name: t.defaultName,
    avatar: t.avatar,
    role: t.role,
    persona: t.persona,
    instructions: t.instructions,
    autonomyLevel: t.autonomyLevel,
    toolPermissions: t.suggestedTools,
    executionMode: t.executionMode ?? "tool",
    egressDomains: t.egressDomains ?? [],
  };
}

function Wizard() {
  const t = useTranslations("hire");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const f = useFormat();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const { data: tpl } = useTemplates();
  const { data: pricing } = useQuery({ queryKey: ["pricing"], queryFn: () => api.get<{ models: { model: string; label: string; inputPer1k: number; outputPer1k: number }[] }>("/api/pricing") });
  const { data: mcp } = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers: { name: string }[] }>("/api/settings/mcp").catch(() => ({ servers: [] })) });
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(blank);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [firstTask, setFirstTask] = useState({ title: "", brief: "", dryRun: true });
  const [taskId, setTaskId] = useState<string | null>(null);
  const withStepUp = useStepUp();

  useEffect(() => {
    const key = sp.get("template");
    const tp = tpl?.templates.find((x) => x.key === key);
    if (tp && !d.templateKey) {
      setD(fromTemplate(tp));
      setStep(1);
    }
  }, [tpl, sp, d.templateKey]);

  useEffect(() => {
    const tp = tpl?.templates.find((x) => x.key === d.templateKey);
    if (tp && !firstTask.title) setFirstTask((ft) => ({ ...ft, title: tp.exampleTasks[0]!.slice(0, 120), brief: tp.exampleTasks[0]! }));
  }, [d.templateKey, tpl, firstTask.title]);

  const hire = useMutation({
    // Workspace mode asks for a 2FA confirmation first (server answers step_up_required)
    mutationFn: () => withStepUp(() => api.post<{ employee: Employee }>("/api/employees", d)),
    onSuccess: (r) => {
      if (!r) return;
      setEmployee(r.employee);
      void qc.invalidateQueries({ queryKey: ["employees"] });
      toast.success(t("joined", { name: r.employee.name }));
      setStep(3);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const runTask = useMutation({
    mutationFn: () => api.post<{ task: { id: string } }>("/api/tasks", { ...firstTask, assigneeId: employee!.id, start: true }),
    onSuccess: (r) => setTaskId(r.task.id),
    onError: (e) => toast.error((e as Error).message),
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const canNext = step === 0 ? true : step === 1 ? d.name.trim() && d.role.trim() : true;

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <ol className="mb-6 grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className={cn("rounded-lg border px-3 py-2 text-xs sm:text-sm", i === step ? "border-primary bg-primary/5 font-medium" : i < step ? "text-muted-foreground" : "text-muted-foreground/70")}>
            <span className="mr-1.5 inline-flex size-5 items-center justify-center rounded-full bg-muted text-[11px]">{i < step ? <Check className="size-3" /> : i + 1}</span>
            <span className="hidden sm:inline">{t(`steps.${s}`)}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tpl?.templates.map((tp) => (
            <button
              key={tp.key}
              type="button"
              onClick={() => {
                setD(fromTemplate(tp));
                setStep(1);
              }}
              className="rounded-xl border bg-card p-4 text-left transition hover:border-primary hover:shadow-sm"
            >
              <div className="flex items-center gap-2">
                <Avatar emoji={tp.avatar} />
                <span className="font-semibold">{tp.role}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{tp.tagline}</p>
              <p className="mt-2 text-xs text-muted-foreground">{t("template.suggested", { count: tp.suggestedTools.length, level: ts(`autonomy.${tp.autonomyLevel}`) })}</p>
            </button>
          ))}
          <button type="button" onClick={() => (setD(blank), setStep(1))} className="rounded-xl border border-dashed p-4 text-left hover:border-primary">
            <div className="flex items-center gap-2 font-semibold">
              <Sparkles className="size-5" /> {t("template.startBlank")}
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t("template.startBlankDescription")}</p>
          </button>
        </div>
      )}

      {step === 1 && (
        <Card>
          <CardContent className="grid gap-4 p-5 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="space-y-1.5">
                  <Label>{t("persona.avatar")}</Label>
                  <Select value={d.avatar} onValueChange={(v) => set("avatar", v)}>
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EMOJIS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="name">{tc("name")}</Label>
                  <Input id="name" value={d.name} onChange={(e) => set("name", e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">{tc("role")}</Label>
                <Input id="role" value={d.role} onChange={(e) => set("role", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona">{t("persona.persona")}</Label>
                <Textarea id="persona" rows={3} value={d.persona} onChange={(e) => set("persona", e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("persona.model")}</Label>
                  <Select value={d.model} onValueChange={(v) => set("model", v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* i18n-ignore: model name */}
                      {(pricing?.models ?? [{ model: DEFAULT_MODEL, label: "Claude Opus 5.5", inputPer1k: 0, outputPer1k: 0 }]).map((m) => (
                        <SelectItem key={m.model} value={m.model}>
                          {t("persona.modelOption", { label: m.label, input: f.number(m.inputPer1k, 4), output: f.number(m.outputPer1k, 4) })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="budget">{t("persona.dailyBudget")}</Label>
                  <Input id="budget" type="number" min={0} value={d.dailyBudget} onChange={(e) => set("dailyBudget", Number(e.target.value))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="output-language">{t("persona.outputLanguage")}</Label>
                <Select value={d.outputLanguage} onValueChange={(v) => set("outputLanguage", v as OutputLanguage)}>
                  <SelectTrigger id="output-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OUTPUT_LANGUAGES.map((l) => (
                      <SelectItem key={l} value={l}>
                        {ts(`outputLanguage.${l}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("persona.outputLanguageHelp")}</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="execution-mode">{t("persona.executionMode")}</Label>
                <Select value={d.executionMode} onValueChange={(v) => set("executionMode", v as Draft["executionMode"])}>
                  <SelectTrigger id="execution-mode" className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tool">{t("persona.modeTool")}</SelectItem>
                    <SelectItem value="workspace">{t("persona.modeWorkspace")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{d.executionMode === "workspace" ? t("persona.modeWorkspaceHelp") : t("persona.modeToolHelp")}</p>
              </div>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="instructions">{t("persona.instructions")}</Label>
                <Textarea id="instructions" rows={8} value={d.instructions} onChange={(e) => set("instructions", e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ctx">{t("persona.businessContext")}</Label>
                <Textarea id="ctx" rows={5} placeholder={t("persona.businessContextPlaceholder")} value={d.businessContext} onChange={(e) => set("businessContext", e.target.value)} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && tpl && (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 font-medium">{t("tools.defaultAutonomy")}</h3>
            <AutonomyPicker value={d.autonomyLevel} onChange={(v) => set("autonomyLevel", v)} />
            <p className="mt-2 text-xs text-muted-foreground">
              {t("tools.irreversibleNote", { level: ts("autonomy.CLOSE") })}
            </p>
          </div>
          <div>
            <h3 className="mb-2 font-medium">{t("tools.toolPermissions")}</h3>
            <ToolPermissionsEditor tools={tpl.tools} value={d.toolPermissions} onChange={(v) => set("toolPermissions", v)} defaultAutonomy={d.autonomyLevel} extraServers={mcp?.servers.map((s) => s.name)} />
          </div>
        </div>
      )}

      {step === 3 && employee && (
        <div className="space-y-4">
          {!taskId ? (
            <Card>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center gap-2">
                  <Avatar emoji={employee.avatar} />
                  <div>
                    <div className="font-medium">{t("firstTask.heading", { name: employee.name })}</div>
                    <div className="text-xs text-muted-foreground">{t("firstTask.hint")}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("firstTask.title")}</Label>
                  <Input value={firstTask.title} onChange={(e) => setFirstTask({ ...firstTask, title: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("firstTask.brief")}</Label>
                  <Textarea rows={4} value={firstTask.brief} onChange={(e) => setFirstTask({ ...firstTask, brief: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={firstTask.dryRun} onChange={(e) => setFirstTask({ ...firstTask, dryRun: e.target.checked })} />
                  {t("firstTask.dryRun")}
                </label>
                <div className="flex gap-2">
                  <Button onClick={() => runTask.mutate()} disabled={!firstTask.title || runTask.isPending}>
                    {t("firstTask.run")}
                  </Button>
                  <Button variant="ghost" asChild>
                    <Link href={`/employees/${employee.id}`}>{t("firstTask.skip")}</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <TaskDetail taskId={taskId} compact />
              <div className="flex gap-2">
                <Button asChild>
                  <Link href={`/employees/${employee.id}`}>{t("firstTask.openProfile", { name: employee.name })}</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href={`/chat?employee=${employee.id}`}>{t("firstTask.chatWith", { name: employee.name })}</Link>
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {step > 0 && step < 3 && (
        <div className="mt-6 flex justify-between">
          <Button variant="ghost" onClick={() => setStep(step - 1)} className="gap-1">
            <ChevronLeft className="size-4" /> {tc("back")}
          </Button>
          {step < 2 ? (
            <Button disabled={!canNext} onClick={() => setStep(step + 1)} className="gap-1">
              {tc("next")} <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button onClick={() => hire.mutate()} disabled={hire.isPending}>
              {d.name ? t("hire", { name: d.name }) : t("hireFallback")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function HirePage() {
  return (
    <Suspense>
      <Wizard />
    </Suspense>
  );
}
