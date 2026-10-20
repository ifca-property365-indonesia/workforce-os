"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, FileUp, Upload } from "lucide-react";
import { PACKAGE_MAX_BYTES } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Note = { code: string } & Record<string, string | number>;
type Bi = { en: string; id: string };
interface Details {
  employees: {
    key: string;
    name: string;
    role: string;
    persona: string;
    instructions: string;
    businessContext: string;
    seedMemories: { kind: string; content: string }[];
    skillSlugs: string[];
    toolPermissions: string[];
    egressDomains: string[];
    executionMode: string;
    specialty: string;
  }[];
  skills: { slug: string; as: string | null; description: string; body: string }[];
  teams: { name: string; description: string; head: string | null; codeLead: string | null; members: string[]; subagents: string[]; sop: Bi | null }[];
  routines: { name: string; cron: string; timezone: string; brief: string }[];
  mcpSlots: { name: string; url: string }[];
  egressHosts: string[];
}
interface Preview {
  ok: boolean;
  name: string;
  details: Details;
  will: { employees: number; teams: number; routines: number; skills: number; mcpSlots: number; memories: number; goals: number };
  warnings: Note[];
  conflicts: { kind: string; name: string; as?: string }[];
  errors: Note[];
}
interface Created {
  employees: { id: string }[];
  teams: { id: string }[];
  routines: { id: string }[];
  skills: { id: string }[];
  mcpSlots: { id: string }[];
  memories: number;
}

const values = ({ code: _code, ...rest }: Note) => rest;

/** URLs and e-mail addresses: where an imported instruction could send data, so they stand out in the preview. */
const LINK_RE = /(https?:\/\/[^\s<>"'`)\]]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/** Text shown as written (never as markup), with URLs and e-mail addresses highlighted. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(LINK_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-approval/40 px-0.5 text-foreground ">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** One labelled block of imported text (empty ones are left out). */
function Field({ label, text }: { label: string; text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-sans text-xs">
        <Highlighted text={text} />
      </pre>
    </div>
  );
}

/** Everything the package would teach its employees, in full: read it before importing. */
function PackageContents({ d }: { d: Details }) {
  const t = useTranslations("packages");
  const chips = (xs: string[]) => (
    <ul className="flex flex-wrap gap-1">
      {xs.map((x) => (
        <li key={x}>
          <code className="rounded border px-1.5 py-0.5 text-xs">{x}</code>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="space-y-2">
      <h3 className="font-medium">{t("import.contents")}</h3>
      <p className="text-xs text-muted-foreground">{t("import.contentsHelp")}</p>
      {d.employees.map((e) => (
        <details key={e.key} className="rounded-md border p-2">
          <summary className="cursor-pointer font-medium">
            {e.name} <span className="font-normal text-muted-foreground">· {e.role}</span>
          </summary>
          <div className="mt-2 space-y-2">
            {e.specialty && <Field label={t("import.specialty")} text={e.specialty} />}
            <Field label={t("import.persona")} text={e.persona} />
            <Field label={t("import.instructions")} text={e.instructions} />
            <Field label={t("import.businessContext")} text={e.businessContext} />
            {e.seedMemories.length > 0 && <Field label={t("import.seedMemories")} text={e.seedMemories.map((m) => `[${m.kind}] ${m.content}`).join("\n")} />}
            {e.skillSlugs.length > 0 && (
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-muted-foreground">{t("import.employeeSkills")}</div>
                {chips(e.skillSlugs)}
              </div>
            )}
            {e.toolPermissions.length > 0 && (
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-muted-foreground">{t("import.tools")}</div>
                {chips(e.toolPermissions)}
              </div>
            )}
            {e.egressDomains.length > 0 && (
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-muted-foreground">{t("import.egress")}</div>
                {chips(e.egressDomains)}
              </div>
            )}
          </div>
        </details>
      ))}
      {d.teams.map((dv, i) => (
        <details key={i} className="rounded-md border p-2">
          <summary className="cursor-pointer font-medium">{t("import.division", { name: dv.name })}</summary>
          <div className="mt-2 space-y-2 text-xs">
            <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr]">
              <dt className="text-muted-foreground">{t("import.divisionHead")}</dt>
              <dd>{dv.head ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("import.divisionCodeLead")}</dt>
              <dd>{dv.codeLead ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("import.divisionMembers")}</dt>
              <dd>{dv.members.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">{t("import.divisionSubagents")}</dt>
              <dd>{dv.subagents.join(", ") || "—"}</dd>
            </dl>
            {dv.sop && <Field label={t("import.sop")} text={[dv.sop.en, dv.sop.id].filter((x) => x.trim()).join("\n\n")} />}
          </div>
        </details>
      ))}
      {d.skills.map((s) => (
        <details key={s.slug} className="rounded-md border border-warning/40 p-2">
          <summary className="cursor-pointer font-medium">
            {t("import.skill", { slug: s.slug })}
            {s.as && <span className="font-normal text-muted-foreground"> · {t("import.skillAs", { slug: s.as })}</span>}
          </summary>
          <div className="mt-2 space-y-2">
            <Field label={t("import.skillDescription")} text={s.description} />
            <Field label={t("import.skillBody")} text={s.body} />
          </div>
        </details>
      ))}
      {d.routines.length > 0 && (
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer font-medium">{t("import.routines", { count: d.routines.length })}</summary>
          <div className="mt-2 space-y-2">
            {d.routines.map((r, i) => (
              <Field key={i} label={`${r.name} · ${r.cron} (${r.timezone})`} text={r.brief} />
            ))}
          </div>
        </details>
      )}
      {d.mcpSlots.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-xs font-medium text-muted-foreground">{t("import.mcpSlots")}</div>
          <ul className="space-y-0.5 text-xs">
            {d.mcpSlots.map((m) => (
              <li key={m.name}>
                <code>{m.name}</code>: <Highlighted text={m.url} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-0.5">
        <div className="text-xs font-medium text-muted-foreground">{t("import.egressAll")}</div>
        {d.egressHosts.length ? chips(d.egressHosts) : <p className="text-xs text-muted-foreground">{t("import.none")}</p>}
      </div>
    </section>
  );
}

/** Drop or paste a package → preview (counts, warnings, clashes) → confirm with a step-up → created. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("packages");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const [parsed, setParsed] = useState<unknown>(null);

  const check = useMutation({
    mutationFn: (pkg: unknown) => api.post<{ preview: Preview }>("/api/packages/import/preview", pkg).then((r) => r.preview),
    onError: (e) => toast.error((e as Error).message),
  });
  const commit = useMutation({
    mutationFn: () => withStepUp(() => api.post<{ created: Created }>("/api/packages/import/commit", parsed).then((r) => r.created)),
    onSuccess: (created) => {
      if (!created) return; // step-up cancelled
      toast.success(t("import.done", { employees: created.employees.length, teams: created.teams.length, routines: created.routines.length }));
      for (const key of ["teams", "employees", "routines", "skills"]) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const run = (raw: string) => {
    setText(raw);
    if (new Blob([raw]).size > PACKAGE_MAX_BYTES * 2) return void toast.error(t("import.tooLarge"));
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return void toast.error(t("import.notJson"));
    }
    setParsed(json);
    check.mutate(json);
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > PACKAGE_MAX_BYTES * 2) return void toast.error(t("import.tooLarge"));
    run(await file.text());
  };

  const pv = check.data;
  const reset = () => {
    check.reset();
    setParsed(null);
    setText("");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{pv ? t("import.titleNamed", { name: pv.name }) : t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>
        {!pv ? (
          <div className="space-y-3 text-sm">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void readFile(e.dataTransfer.files[0]);
              }}
              className={cn("flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-muted-foreground", over && "border-primary bg-primary/5")}
            >
              <FileUp className="size-6" />
              <span>{t("import.drop")}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                {t("import.choose")}
              </Button>
              <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
            </div>
            <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("import.pastePlaceholder")} className="font-mono text-xs" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <section>
              <h3 className="mb-1 font-medium">{t("import.will")}</h3>
              <p className="text-muted-foreground">{t("import.willCounts", pv.will)}</p>
            </section>
            {pv.errors.length > 0 && (
              <section className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                <h3 className="mb-1 font-medium text-destructive">{t("import.errors")}</h3>
                <ul className="list-inside list-disc">
                  {pv.errors.map((n, i) => (
                    <li key={i}>{t.has(`issues.${n.code}`) ? t(`issues.${n.code}`, values(n)) : n.code}</li>
                  ))}
                </ul>
              </section>
            )}
            {pv.warnings.length > 0 && (
              <section>
                <h3 className="mb-1 flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-4 text-warning" /> {t("import.warnings")}
                </h3>
                <ul className="list-inside list-disc text-muted-foreground">
                  {pv.warnings.map((n, i) => (
                    <li key={i}>{t.has(`warnings.${n.code}`) ? t(`warnings.${n.code}`, values(n)) : n.code}</li>
                  ))}
                </ul>
              </section>
            )}
            <PackageContents d={pv.details} />
            {pv.conflicts.length > 0 && (
              <section>
                <h3 className="mb-1 font-medium">{t("import.conflicts")}</h3>
                <p className="mb-1 text-xs text-muted-foreground">{t("import.conflictsHelp")}</p>
                <ul className="list-inside list-disc">
                  {pv.conflicts.map((c, i) => (
                    <li key={i}>
                      {t.has(`conflicts.${c.kind}`) ? t(`conflicts.${c.kind}`) : c.kind}: {c.as ? t("conflicts.renamed", { name: c.name, as: c.as }) : c.name}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={pv ? reset : onClose}>
            {pv ? t("import.back") : tc("cancel")}
          </Button>
          {pv ? (
            <Button onClick={() => commit.mutate()} disabled={!pv.ok || commit.isPending} className="gap-1.5">
              <Upload className="size-4" /> {t("import.confirm")}
            </Button>
          ) : (
            <Button onClick={() => run(text)} disabled={!text.trim() || check.isPending}>
              {t("import.check")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportButton() {
  const t = useTranslations("packages");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="gap-1.5">
        <Upload className="size-3.5" /> {t("import.button")}
      </Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}
