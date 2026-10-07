"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { DEFAULT_MODEL, type AutonomyLevel, type ToolPermission } from "@wfos/shared";
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
import { cn } from "@/lib/utils";

const STEPS = ["Template", "Persona & context", "Tools & autonomy", "First task"];
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
  };
}

function Wizard() {
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

  useEffect(() => {
    const key = sp.get("template");
    const t = tpl?.templates.find((x) => x.key === key);
    if (t && !d.templateKey) {
      setD(fromTemplate(t));
      setStep(1);
    }
  }, [tpl, sp, d.templateKey]);

  useEffect(() => {
    const t = tpl?.templates.find((x) => x.key === d.templateKey);
    if (t && !firstTask.title) setFirstTask((f) => ({ ...f, title: t.exampleTasks[0]!.slice(0, 120), brief: t.exampleTasks[0]! }));
  }, [d.templateKey, tpl, firstTask.title]);

  const hire = useMutation({
    mutationFn: () => api.post<{ employee: Employee }>("/api/employees", d),
    onSuccess: (r) => {
      setEmployee(r.employee);
      void qc.invalidateQueries({ queryKey: ["employees"] });
      toast.success(`${r.employee.name} joined the team`);
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
      <PageHeader title="Hire an AI employee" description="Four steps: role → persona & context → tools & autonomy → a first bounded task." />
      <ol className="mb-6 grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className={cn("rounded-lg border px-3 py-2 text-xs sm:text-sm", i === step ? "border-primary bg-primary/5 font-medium" : i < step ? "text-muted-foreground" : "text-muted-foreground/70")}>
            <span className="mr-1.5 inline-flex size-5 items-center justify-center rounded-full bg-muted text-[11px]">{i < step ? <Check className="size-3" /> : i + 1}</span>
            <span className="hidden sm:inline">{s}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tpl?.templates.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setD(fromTemplate(t));
                setStep(1);
              }}
              className="rounded-xl border bg-card p-4 text-left transition hover:border-primary hover:shadow-sm"
            >
              <div className="flex items-center gap-2">
                <Avatar emoji={t.avatar} />
                <span className="font-semibold">{t.role}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{t.tagline}</p>
              <p className="mt-2 text-xs text-muted-foreground">{t.suggestedTools.length} suggested tools · {t.autonomyLevel}</p>
            </button>
          ))}
          <button type="button" onClick={() => (setD(blank), setStep(1))} className="rounded-xl border border-dashed p-4 text-left hover:border-primary">
            <div className="flex items-center gap-2 font-semibold">
              <Sparkles className="size-5" /> Start blank
            </div>
            <p className="mt-2 text-sm text-muted-foreground">Define a custom role from scratch.</p>
          </button>
        </div>
      )}

      {step === 1 && (
        <Card>
          <CardContent className="grid gap-4 p-5 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="space-y-1.5">
                  <Label>Avatar</Label>
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
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={d.name} onChange={(e) => set("name", e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">Role</Label>
                <Input id="role" value={d.role} onChange={(e) => set("role", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona">Persona</Label>
                <Textarea id="persona" rows={3} value={d.persona} onChange={(e) => set("persona", e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Model</Label>
                  <Select value={d.model} onValueChange={(v) => set("model", v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(pricing?.models ?? [{ model: DEFAULT_MODEL, label: "Claude Opus 5.5", inputPer1k: 0, outputPer1k: 0 }]).map((m) => (
                        <SelectItem key={m.model} value={m.model}>
                          {m.label} · {m.inputPer1k}/{m.outputPer1k} cr per 1K
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="budget">Daily budget (credits)</Label>
                  <Input id="budget" type="number" min={0} value={d.dailyBudget} onChange={(e) => set("dailyBudget", Number(e.target.value))} />
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="instructions">Instructions</Label>
                <Textarea id="instructions" rows={8} value={d.instructions} onChange={(e) => set("instructions", e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ctx">Business context</Label>
                <Textarea id="ctx" rows={5} placeholder="Who you are, your clients, tone, constraints…" value={d.businessContext} onChange={(e) => set("businessContext", e.target.value)} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && tpl && (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 font-medium">Default autonomy</h3>
            <AutonomyPicker value={d.autonomyLevel} onChange={(v) => set("autonomyLevel", v)} />
            <p className="mt-2 text-xs text-muted-foreground">
              Irreversible actions (send, publish, pay, delete, merge, deploy) always need per-action approval unless an Owner allow-lists them for a CLOSE employee. This is enforced in the tool layer.
            </p>
          </div>
          <div>
            <h3 className="mb-2 font-medium">Tool permissions</h3>
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
                    <div className="font-medium">Give {employee.name} a first bounded task</div>
                    <div className="text-xs text-muted-foreground">Review the output and every step before trusting them with more.</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input value={firstTask.title} onChange={(e) => setFirstTask({ ...firstTask, title: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Brief</Label>
                  <Textarea rows={4} value={firstTask.brief} onChange={(e) => setFirstTask({ ...firstTask, brief: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={firstTask.dryRun} onChange={(e) => setFirstTask({ ...firstTask, dryRun: e.target.checked })} />
                  Dry run (irreversible tools are mocked)
                </label>
                <div className="flex gap-2">
                  <Button onClick={() => runTask.mutate()} disabled={!firstTask.title || runTask.isPending}>
                    Run first task
                  </Button>
                  <Button variant="ghost" asChild>
                    <Link href={`/employees/${employee.id}`}>Skip</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <TaskDetail taskId={taskId} compact />
              <div className="flex gap-2">
                <Button asChild>
                  <Link href={`/employees/${employee.id}`}>Open {employee.name}&apos;s profile</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href={`/chat?employee=${employee.id}`}>Chat with {employee.name}</Link>
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {step > 0 && step < 3 && (
        <div className="mt-6 flex justify-between">
          <Button variant="ghost" onClick={() => setStep(step - 1)} className="gap-1">
            <ChevronLeft className="size-4" /> Back
          </Button>
          {step < 2 ? (
            <Button disabled={!canNext} onClick={() => setStep(step + 1)} className="gap-1">
              Next <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button onClick={() => hire.mutate()} disabled={hire.isPending}>
              Hire {d.name || "employee"}
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
