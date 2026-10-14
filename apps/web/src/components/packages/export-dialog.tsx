"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, ShieldCheck } from "lucide-react";
import { packageFileName, type WfosPackage } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";

export interface ExportReport {
  included: { employees: string[]; teams: string[]; routines: string[]; skills: string[]; mcpSlots: string[] };
  redactions: { where: string; rule: string }[];
  leftOut: string[];
  counts: { employees: number; teams: number; routines: number; skills: number; mcpSlots: number; memories: number; redactions: number };
}

interface Selection {
  employeeIds?: string[];
  teamIds?: string[];
}

const GROUPS = ["employees", "teams", "routines", "skills", "mcpSlots"] as const;

/** Save a package as <name>.wfos.json in the browser. */
function download(pkg: WfosPackage): string {
  const file = packageFileName(pkg.meta.name);
  const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return file;
}

/** Dry-run report (what goes in, what was redacted, what never leaves), then the download. */
export function ExportDialog({ selection, name, onClose }: { selection: Selection; name?: string; onClose: () => void }) {
  const t = useTranslations("packages");
  const tc = useTranslations("common");
  const [includeMemories, setIncludeMemories] = useState(false);
  const opts = { ...selection, includeMemories };
  const dry = useMutation({
    mutationFn: () => api.post<{ report: ExportReport }>("/api/packages/export", { ...opts, dryRun: true }).then((r) => r.report),
    onError: (e) => toast.error((e as Error).message),
  });
  const real = useMutation({
    mutationFn: () => api.post<{ package: WfosPackage }>("/api/packages/export", opts).then((r) => r.package),
    onSuccess: (pkg) => {
      toast.success(t("export.downloaded", { file: download(pkg) }));
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const { mutate } = dry;
  useEffect(() => {
    mutate();
  }, [mutate, includeMemories]);

  const report = dry.data;
  const empty = !!report && report.counts.employees === 0 && report.counts.teams === 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{name ? t("export.title", { name }) : t("export.titleAll")}</DialogTitle>
          <DialogDescription>{t("export.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeMemories} onChange={(e) => setIncludeMemories(e.target.checked)} /> {t("export.includeMemories")}
            </label>
          </div>
          {!report && <p className="text-muted-foreground">{t("export.checking")}</p>}
          {empty && <p className="text-muted-foreground">{t("export.nothing")}</p>}
          {report && !empty && (
            <>
              <section>
                <h3 className="mb-1 font-medium">{t("export.included")}</h3>
                <p className="mb-2 text-muted-foreground">{t("export.counts", report.counts)}</p>
                <dl className="grid gap-1.5 sm:grid-cols-[10rem_1fr]">
                  {GROUPS.filter((g) => report.included[g].length).map((g) => (
                    <div key={g} className="contents">
                      <dt className="text-muted-foreground">{t(`export.groups.${g}`)}</dt>
                      <dd className="break-words">{report.included[g].join(", ")}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section>
                <h3 className="mb-1 flex items-center gap-1.5 font-medium">
                  <ShieldCheck className="size-4 text-success" /> {t("export.redactions", { count: report.redactions.length })}
                </h3>
                {report.redactions.length ? (
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-2 font-mono text-xs">
                    {report.redactions.map((r, i) => (
                      <li key={i}>
                        {r.where} · {t.has(`rules.${r.rule}`) ? t(`rules.${r.rule}`) : r.rule}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">{t("export.noRedactions")}</p>
                )}
              </section>
              <section>
                <h3 className="mb-1 font-medium">{t("export.leftOut")}</h3>
                <ul className="list-inside list-disc text-muted-foreground">
                  {report.leftOut.map((k) => (
                    <li key={k}>{t.has(`leftOut.${k}`) ? t(`leftOut.${k}`) : k}</li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button onClick={() => real.mutate()} disabled={!report || empty || dry.isPending || real.isPending} className="gap-1.5">
            <Download className="size-4" /> {t("export.download")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Export" button that opens the export dialog for a selection (nothing selected = everything). */
export function ExportButton({ selection = {}, name, label, size = "sm", variant = "outline" }: { selection?: Selection; name?: string; label?: string; size?: "sm" | "default"; variant?: "outline" | "secondary" | "ghost" }) {
  const t = useTranslations("packages");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} className="gap-1.5">
        <Download className="size-3.5" /> {label ?? t("export.button")}
      </Button>
      {open && <ExportDialog selection={selection} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}
