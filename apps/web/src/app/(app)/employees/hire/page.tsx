"use client";

import { useStepUp } from "@/components/account/step-up";

import Link, { useSearchParams } from "@/lib/nav";
import { Suspense, useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { DEFAULT_MODEL, OUTPUT_LANGUAGES, type AutonomyLevel, type OutputLanguage, type TeamMemberRole, type ToolPermission } from "@wfos/shared";
import { DIVISION_TEMPLATES, type RoleTemplate } from "@wfos/templates";
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
import { useTeams, useTemplates, type Employee, type Team } from "@/lib/hooks";
import { divisionSignVars } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

const STEPS = ["template", "persona", "tools", "firstTask"] as const;

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
  specialty: string;
  /** the division the new employee joins right away (optional) */
  teamId: string;
  membership: TeamMemberRole;
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
  specialty: "",
  teamId: "",
  membership: "member",
};

/** the standard division a template belongs to, and how (member or subagent of the code lead) */
function templateDivision(key: string): { key: string; membership: TeamMemberRole } | null {
  for (const d of DIVISION_TEMPLATES) {
    if (d.head === key || d.codeLead === key) return { key: d.key, membership: "member" };
    const m = d.members.find((x) => x.role === key);
    if (m) return { key: d.key, membership: m.membership };
  }
  return null;
}

function fromTemplate(t: RoleTemplate, divisions: Team[]): Draft {
  const home = templateDivision(t.key);
  const division = home ? divisions.find((d) => d.key === home.key) : undefined;
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
    model: t.model ?? DEFAULT_MODEL,
    specialty: t.specialty,
    teamId: division?.id ?? "",
    // a subagent needs a code lead to work for: without one yet, the new hire starts as a member
    membership: home?.membership === "subagent" && division?.codeLeadId ? "subagent" : "member",
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
  const { data: divisions } = useTeams();
  const tt = useTranslations("teams");
  const locale = useLocale() as "en" | "id";
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
    // wait for the divisions too: a template lands in its standard division when the workspace has it
    if (tp && !d.templateKey && divisions) {
      setD(fromTemplate(tp, divisions));
      setStep(1);
    }
  }, [tpl, sp, d.templateKey, divisions]);

  useEffect(() => {
    const tp = tpl?.templates.find((x) => x.key === d.templateKey);
    if (tp && !firstTask.title) setFirstTask((ft) => ({ ...ft, title: tp.exampleTasks[0]!.slice(0, 120), brief: tp.exampleTasks[0]! }));
  }, [d.templateKey, tpl, firstTask.title]);

  const hire = useMutation({
    // Workspace mode asks for a 2FA confirmation first (server answers step_up_required)
    mutationFn: () => {
      const { teamId, membership, ...input } = d;
      return withStepUp(() => api.post<{ employee: Employee }>("/api/employees", { ...input, division: teamId ? { teamId, role: membership } : null }));
    },
    onSuccess: (r) => {
      if (!r) return;
      setEmployee(r.employee);
      void qc.invalidateQueries({ queryKey: ["employees"] });
      void qc.invalidateQueries({ queryKey: ["teams"] });
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
        <div className="space-y-6">
          {DIVISION_TEMPLATES.map((dv) => {
            const keys = [dv.head, ...(dv.codeLead ? [dv.codeLead] : []), ...dv.members.map((m) => m.role)];
            const tps = [...new Set(keys)].map((k) => tpl?.templates.find((x) => x.key === k)).filter((x): x is RoleTemplate => !!x);
            if (!tps.length) return null;
            const here = divisions?.find((x) => x.key === dv.key);
            return (
              <section key={dv.key} aria-labelledby={`hire-${dv.key}`}>
                <div className="mb-2 flex flex-wrap items-end gap-3">
                  <h2 id={`hire-${dv.key}`} className="sign rounded-[10px] px-3 py-1.5" data-state="lit" style={divisionSignVars(here?.color || dv.color, dv.key) as CSSProperties}>
                    <span className="font-display text-[1.5rem]">{here?.name ?? dv.name[locale]}</span>
                  </h2>
                  <p className="max-w-[70ch] text-xs text-muted-foreground">{dv.description[locale]}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {tps.map((tp) => {
                    const place = tp.key === dv.head ? "head" : tp.key === dv.codeLead ? "code_lead" : (dv.members.find((m) => m.role === tp.key)?.membership ?? "member");
                    return (
                      <button
                        key={tp.key}
                        type="button"
                        onClick={() => {
                          setD(fromTemplate(tp, divisions ?? []));
                          setStep(1);
                        }}
                        className="rounded-xl border bg-card p-4 text-left transition hover:border-primary hover:shadow-sm"
                      >
                        <div className="flex items-center gap-2">
                          <Avatar seed={tp.key} />
                          <span className="min-w-0 flex-1 truncate font-semibold">{tp.role}</span>
                          <span className="shrink-0 rounded-md bg-secondary px-1.5 text-[10.5px] font-bold uppercase leading-4 text-muted-foreground">{tt(`roles.${place}`)}</span>
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">{tp.tagline}</p>
                        <p className="mt-2 text-xs text-muted-foreground">{t("template.suggested", { count: tp.suggestedTools.length, level: ts(`autonomy.${tp.autonomyLevel}`) })}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          <section aria-labelledby="hire-other">
            <h2 id="hire-other" className="mb-2 text-sm font-semibold">
              {t("template.other")}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tpl?.templates
                .filter((tp) => !templateDivision(tp.key))
                .map((tp) => (
                  <button
                    key={tp.key}
                    type="button"
                    onClick={() => {
                      setD(fromTemplate(tp, divisions ?? []));
                      setStep(1);
                    }}
                    className="rounded-xl border bg-card p-4 text-left transition hover:border-primary hover:shadow-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Avatar seed={tp.key} />
                      <span className="font-semibold">{tp.role}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{tp.tagline}</p>
                  </button>
                ))}
              <button type="button" onClick={() => (setD(blank), setStep(1))} className="rounded-xl border border-dashed p-4 text-left hover:border-primary">
                <div className="flex items-center gap-2 font-semibold">
                  <Sparkles className="size-5" /> {t("template.startBlank")}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{t("template.startBlankDescription")}</p>
              </button>
            </div>
          </section>
        </div>
      )}

      {step === 1 && (
        <Card>
          <CardContent className="grid gap-4 p-5 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">{tc("name")}</Label>
                <Input id="name" value={d.name} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">{tc("role")}</Label>
                <Input id="role" value={d.role} onChange={(e) => set("role", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="specialty">{t("persona.specialty")}</Label>
                <Input id="specialty" value={d.specialty} maxLength={200} onChange={(e) => set("specialty", e.target.value)} placeholder={t("persona.specialtyPlaceholder")} />
                <p className="text-xs text-muted-foreground">{t("persona.specialtyHelp")}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="division">{t("persona.division")}</Label>
                  <select
                    id="division"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={d.teamId}
                    onChange={(e) => {
                      const next = divisions?.find((x) => x.id === e.target.value);
                      setD((x) => ({ ...x, teamId: e.target.value, membership: next?.codeLeadId ? x.membership : "member" }));
                    }}
                  >
                    <option value="">{t("persona.noDivision")}</option>
                    {divisions?.map((dv) => (
                      <option key={dv.id} value={dv.id}>
                        {dv.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="membership">{t("persona.membership")}</Label>
                  <select id="membership" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={d.membership} disabled={!d.teamId} onChange={(e) => set("membership", e.target.value as TeamMemberRole)}>
                    <option value="member">{tt("roles.member")}</option>
                    <option value="subagent" disabled={!divisions?.find((x) => x.id === d.teamId)?.codeLeadId}>
                      {tt("roles.subagent")}
                    </option>
                  </select>
                </div>
                <p className="col-span-2 text-xs text-muted-foreground">{d.membership === "subagent" ? t("persona.subagentHelp") : t("persona.divisionHelp")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona">{t("persona.persona")}</Label>
                <Textarea id="persona" rows={3} value={d.persona} onChange={(e) => set("persona", e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="model">{t("persona.model")}</Label>
                  <Select value={d.model} onValueChange={(v) => set("model", v)}>
                    <SelectTrigger id="model">
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
            <ToolPermissionsEditor tools={tpl.tools} value={d.toolPermissions} onChange={(f) => setD((x) => ({ ...x, toolPermissions: f(x.toolPermissions) }))} defaultAutonomy={d.autonomyLevel} extraServers={mcp?.servers.map((s) => s.name)} />
          </div>
        </div>
      )}

      {step === 3 && employee && (
        <div className="space-y-4">
          {!taskId ? (
            <Card>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center gap-2">
                  <Avatar id={employee.id} />
                  <div>
                    <div className="font-medium">{t("firstTask.heading", { name: employee.name })}</div>
                    <div className="text-xs text-muted-foreground">{t("firstTask.hint")}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="first-task-title">{t("firstTask.title")}</Label>
                  <Input id="first-task-title" value={firstTask.title} onChange={(e) => setFirstTask({ ...firstTask, title: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="first-task-brief">{t("firstTask.brief")}</Label>
                  <Textarea id="first-task-brief" rows={4} value={firstTask.brief} onChange={(e) => setFirstTask({ ...firstTask, brief: e.target.value })} />
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
