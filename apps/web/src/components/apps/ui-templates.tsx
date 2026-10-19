"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ExternalLink, Frame, Moon, Paintbrush, Plus, Sun } from "lucide-react";
import Link from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useEmployees, useTeams } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export const SCREENS = ["dashboard", "list", "form", "detail", "login"] as const;
type Screen = (typeof SCREENS)[number];
export interface BuiltinTemplate {
  ref: string;
  id: string;
  name: string;
  mode: "light" | "dark";
  tags: string[];
  summary: { id: string; en: string };
  fonts: Record<"display" | "body" | "mono", { family: string; package: string }>;
  colors: string[];
}
export interface CustomTemplate {
  ref: string;
  id: string;
  name: string;
  mode: "light" | "dark";
  summary: string;
  hasPreview: boolean;
  createdAt: string;
}
interface AppDesign {
  template: { ref: string; from: "app" | "client"; name: string; builtin: boolean; mode: "light" | "dark"; summary: string } | null;
  figma: { url: string; from: "app" | "client" } | null;
}

export const useUiTemplates = () => useQuery({ queryKey: ["ui-templates"], queryFn: () => api.get<{ builtin: BuiltinTemplate[]; custom: CustomTemplate[] }>("/api/ui-templates") });
const previewUrl = (ref: string, screen: Screen) => `/api/ui-templates/preview?ref=${encodeURIComponent(ref)}&screen=${screen}`;
const onError = (e: unknown) => toast.error((e as Error).message);

/** A template's screen, rendered at 1280×800 in a sandboxed frame (nothing in it runs) and scaled to its box. */
export function TemplatePreview({ refId, screen = "dashboard", title, className }: { refId: string; screen?: Screen; title: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setScale((e?.contentRect.width ?? 320) / 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={cn("relative aspect-[16/10] overflow-hidden rounded-lg border bg-muted", className)}>
      <iframe
        title={title}
        src={previewUrl(refId, screen)}
        sandbox=""
        loading="lazy"
        tabIndex={-1}
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
        style={{ width: 1280, height: 800, transform: `scale(${scale})` }}
      />
    </div>
  );
}

/** C5: the gallery of UI templates: the built-in kits and the workspace's own, each with a live preview. */
export function UiTemplateGallery({ admin }: { admin: boolean }) {
  const t = useTranslations("apps.templates");
  const locale = useLocale();
  const { data } = useUiTemplates();
  const [mode, setMode] = useState<"all" | "light" | "dark">("all");
  const [open, setOpen] = useState<{ ref: string; name: string } | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const kits = (data?.builtin ?? []).filter((k) => mode === "all" || k.mode === mode);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("mode")} className="flex gap-1.5">
          {(["all", "light", "dark"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium", mode === m ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-secondary/60")}
            >
              {m === "light" && <Sun className="size-3.5" aria-hidden />}
              {m === "dark" && <Moon className="size-3.5" aria-hidden />}
              {t(`modes.${m}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {admin && (
          <Button variant="outline" className="gap-1.5" onClick={() => setEditing("new")}>
            <Plus className="size-4" aria-hidden /> {t("addCustom")}
          </Button>
        )}
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {kits.map((k) => (
          <li key={k.ref} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
            <button type="button" onClick={() => setOpen({ ref: k.ref, name: k.name })} className="rounded-lg text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={t("openPreview", { name: k.name })}>
              <TemplatePreview refId={k.ref} title={k.name} />
            </button>
            <div className="flex items-center gap-2">
              <h3 className="flex-1 font-semibold">{k.name}</h3>
              <span className="flex gap-1" aria-hidden>
                {k.colors.slice(0, 3).map((c) => (
                  <span key={c} className="size-3.5 rounded-full border" style={{ background: c }} />
                ))}
              </span>
              <span className="rounded bg-secondary px-1.5 text-[11px] font-semibold uppercase">{t(`modes.${k.mode}`)}</span>
            </div>
            <p className="text-sm text-muted-foreground">{locale.startsWith("id") ? k.summary.id : k.summary.en}</p>
            <p className="text-xs text-muted-foreground">{t("fonts", { display: k.fonts.display.family, body: k.fonts.body.family })}</p>
          </li>
        ))}
      </ul>

      <section className="space-y-3" aria-labelledby="custom-templates">
        <h2 id="custom-templates" className="font-display text-[1.5rem] leading-none">
          {t("customTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("customExplain")}</p>
        {!data?.custom.length ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("customEmpty")}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.custom.map((c) => (
              <li key={c.ref} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
                {c.hasPreview ? <TemplatePreview refId={c.ref} title={c.name} /> : <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed text-xs text-muted-foreground">{t("noPreview")}</div>}
                <div className="flex items-center gap-2">
                  <h3 className="flex-1 font-semibold">{c.name}</h3>
                  <span className="rounded bg-secondary px-1.5 text-[11px] font-semibold uppercase">{t(`modes.${c.mode}`)}</span>
                </div>
                {c.summary && <p className="text-sm text-muted-foreground">{c.summary}</p>}
                <div className="flex gap-1.5">
                  {c.hasPreview && (
                    <Button size="sm" variant="ghost" onClick={() => setOpen({ ref: c.ref, name: c.name })}>
                      {t("preview")}
                    </Button>
                  )}
                  {admin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c.id)}>
                      {t("edit")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {open && <PreviewDialog refId={open.ref} name={open.name} onClose={() => setOpen(null)} />}
      {editing && <CustomTemplateDialog id={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PreviewDialog({ refId, name, onClose }: { refId: string; name: string; onClose: () => void }) {
  const t = useTranslations("apps.templates");
  const [screen, setScreen] = useState<Screen>("dashboard");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
        </DialogHeader>
        <div role="tablist" aria-label={t("screens")} className="flex flex-wrap gap-1">
          {SCREENS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={screen === s} onClick={() => setScreen(s)} className={cn("h-8 rounded-md px-3 text-sm", screen === s ? "bg-secondary font-semibold" : "text-muted-foreground hover:bg-secondary/60")}>
              {t(`screen.${s}`)}
            </button>
          ))}
          <span className="flex-1" />
          <a href={previewUrl(refId, screen)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
            <ExternalLink className="size-3.5" aria-hidden /> {t("openTab")}
          </a>
        </div>
        <TemplatePreview refId={refId} screen={screen} title={`${name} · ${t(`screen.${screen}`)}`} />
      </DialogContent>
    </Dialog>
  );
}

function CustomTemplateDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations("apps.templates");
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["ui-template", id],
    queryFn: () => api.get<{ template: { name: string; mode: "light" | "dark"; summary: string; design: string; tokensCss: string; usedBy: number } }>(`/api/ui-templates/${id}`),
    enabled: !!id,
    // always the stored version: the form is seeded once from it
    gcTime: 0,
    staleTime: 0,
  });
  const [form, setForm] = useState<{ name: string; mode: "light" | "dark"; summary: string; design: string; tokensCss: string } | null>(id ? null : { name: "", mode: "light", summary: "", design: "", tokensCss: "" });
  useEffect(() => {
    if (data && !form) setForm({ name: data.template.name, mode: data.template.mode, summary: data.template.summary, design: data.template.design, tokensCss: data.template.tokensCss });
  }, [data, form]);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["ui-templates"] });
    void qc.invalidateQueries({ queryKey: ["ui-template"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => (id ? api.patch(`/api/ui-templates/${id}`, form) : api.post("/api/ui-templates", form)),
    onSuccess: () => {
      toast.success(t("saved"));
      done();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/ui-templates/${id}`),
    onSuccess: () => {
      toast.success(t("removed"));
      done();
    },
    onError,
  });
  const set = (k: keyof NonNullable<typeof form>, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{id ? t("editTitle") : t("addTitle")}</DialogTitle>
        </DialogHeader>
        {form && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1">
                <Label htmlFor="tpl-name">{t("name")}</Label>
                <Input id="tpl-name" value={form.name} maxLength={60} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tpl-mode">{t("mode")}</Label>
                <select id="tpl-mode" className="h-9 rounded-md border bg-background px-2 text-sm" value={form.mode} onChange={(e) => set("mode", e.target.value)}>
                  <option value="light">{t("modes.light")}</option>
                  <option value="dark">{t("modes.dark")}</option>
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-summary">{t("summary")}</Label>
              <Input id="tpl-summary" value={form.summary} maxLength={500} onChange={(e) => set("summary", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-design">{t("design")}</Label>
              <Textarea id="tpl-design" rows={10} className="font-mono text-xs" value={form.design} maxLength={40000} onChange={(e) => set("design", e.target.value)} placeholder={t("designPlaceholder")} />
              <p className="text-xs text-muted-foreground">{t("designHelp")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-tokens">{t("tokens")}</Label>
              <Textarea id="tpl-tokens" rows={6} className="font-mono text-xs" value={form.tokensCss} maxLength={20000} onChange={(e) => set("tokensCss", e.target.value)} placeholder={t("tokensPlaceholder")} />
              <p className="text-xs text-muted-foreground">{t("tokensHelp")}</p>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          {id && (
            <Button variant="ghost" className="mr-auto text-destructive" disabled={remove.isPending || !!data?.template.usedBy} title={data?.template.usedBy ? t("inUse", { count: data.template.usedBy }) : undefined} onClick={() => confirm(t("removeConfirm")) && remove.mutate()}>
              {t("remove")}
            </Button>
          )}
          <Button disabled={!form || save.isPending || form.name.trim().length < 2 || form.design.trim().length < 50} onClick={() => save.mutate()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** C5 on the app: its UI template and Figma file (its own, else its client's), and "apply the look" as a task. */
export function AppDesignCard({ app, admin }: { app: { id: string; name: string; clientId: string | null; repositoryId: string | null }; admin: boolean }) {
  const t = useTranslations("apps.templates");
  const qc = useQueryClient();
  const key = ["app", app.id, "design"];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ own: { uiTemplate: string | null; figmaUrl: string | null }; client: { uiTemplate: string | null; figmaUrl: string | null } | null; effective: AppDesign }>(`/api/apps/${app.id}/design`),
  });
  const { data: templates } = useUiTemplates();
  const [editing, setEditing] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const eff = data?.effective;
  const options = useMemo(() => [...(templates?.builtin ?? []).map((k) => ({ ref: k.ref, name: k.name })), ...(templates?.custom ?? []).map((c) => ({ ref: c.ref, name: c.name }))], [templates]);
  const [tpl, setTpl] = useState<string>("");
  const [figma, setFigma] = useState("");
  const [forClient, setForClient] = useState(false);
  // the form holds the app's OWN values ("" = follow the client): saving one field never copies the client's other one
  const open = () => {
    setTpl(data?.own.uiTemplate ?? "");
    setFigma(data?.own.figmaUrl ?? "");
    setForClient(false);
    setEditing(true);
  };
  const close = () => {
    setForClient(false);
    setEditing(false);
  };
  const clientTpl = options.find((o) => o.ref === data?.client?.uiTemplate)?.name ?? null;
  const save = useMutation({
    mutationFn: async () => {
      const b = { uiTemplate: tpl || null, figmaUrl: figma.trim() || null };
      if (forClient && app.clientId) {
        await api.put(`/api/clients/${app.clientId}/design`, b);
        // the app follows its client from now on
        return api.put(`/api/apps/${app.id}/design`, { uiTemplate: null, figmaUrl: null });
      }
      return api.put(`/api/apps/${app.id}/design`, b);
    },
    onSuccess: () => {
      toast.success(t("designSaved"));
      close();
      void qc.invalidateQueries({ queryKey: key });
    },
    onError,
  });
  return (
    <section className="space-y-3" aria-labelledby="app-design-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="app-design-title" className="font-display flex-1 text-[1.7rem] leading-none">
          {t("lookTitle")}
        </h2>
        <Button asChild size="sm" variant="ghost">
          <Link href="/apps/templates">{t("gallery")}</Link>
        </Button>
        {admin && !editing && (
          <Button size="sm" variant="outline" disabled={!data} onClick={open}>
            {t("change")}
          </Button>
        )}
        {admin && !editing && (eff?.template || eff?.figma) && (
          <Button size="sm" className="gap-1.5" disabled={!app.repositoryId} onClick={() => setRestyling(true)}>
            <Paintbrush className="size-3.5" aria-hidden /> {t("restyle")}
          </Button>
        )}
      </div>
      <div className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-[minmax(0,320px)_1fr]">
        {eff?.template && (eff.template.builtin || templates?.custom.find((c) => c.ref === eff.template!.ref)?.hasPreview) ? (
          <TemplatePreview refId={eff.template.ref} title={eff.template.name} />
        ) : (
          <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">{t("noTemplate")}</div>
        )}
        {!editing ? (
          <div className="space-y-2 text-sm">
            <p>
              {eff?.template ? (
                <>
                  <strong>{eff.template.name}</strong> · {t(`modes.${eff.template.mode}`)} · <span className="text-muted-foreground">{t(eff.template.from === "client" ? "fromClient" : "fromApp")}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{t("noTemplateLong")}</span>
              )}
            </p>
            {eff?.template?.summary && <p className="text-muted-foreground">{eff.template.summary}</p>}
            <p className="flex items-center gap-1.5">
              <Frame className="size-4" aria-hidden />
              {eff?.figma ? (
                <a href={eff.figma.url} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                  {eff.figma.url}
                </a>
              ) : (
                <span className="text-muted-foreground">{t("noFigma")}</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">{t("lookExplain")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="design-tpl">{t("template")}</Label>
              <select id="design-tpl" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={tpl} onChange={(e) => setTpl(e.target.value)}>
                <option value="">{forClient || !app.clientId ? t("none") : clientTpl ? t("followClient", { name: clientTpl }) : t("none")}</option>
                {options.map((o) => (
                  <option key={o.ref} value={o.ref}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="design-figma">{t("figma")}</Label>
              <Input id="design-figma" value={figma} onChange={(e) => setFigma(e.target.value)} placeholder={(!forClient && data?.client?.figmaUrl) || "https://www.figma.com/design/…"} />
              <p className="text-xs text-muted-foreground">{t("figmaHelp")}</p>
            </div>
            {app.clientId && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={forClient} onChange={(e) => setForClient(e.target.checked)} /> {t("forClient")}
              </label>
            )}
            <div className="flex gap-2">
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                {t("save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={close}>
                {t("cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
      {restyling && <RestyleDialog app={app} name={eff?.template?.name ?? "Figma"} onClose={() => setRestyling(false)} />}
    </section>
  );
}

function RestyleDialog({ app, name, onClose }: { app: { id: string; name: string }; name: string; onClose: () => void }) {
  const t = useTranslations("apps.templates");
  const { data: employees } = useEmployees();
  const { data: teams } = useTeams();
  // only who can change code: Workspace-mode employees, divisions with a code lead
  const builders = useMemo(() => (employees ?? []).filter((e) => e.status !== "ARCHIVED" && e.executionMode === "workspace").sort((a, b) => a.name.localeCompare(b.name)), [employees]);
  const codeDivisions = (teams ?? []).filter((d) => d.codeLeadId);
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const pick = who || (builders[0] ? `e:${builders[0].id}` : "");
  const go = useMutation({
    mutationFn: () => api.post(`/api/apps/${app.id}/restyle`, { note, ...(pick.startsWith("t:") ? { teamId: pick.slice(2) } : { employeeId: pick.slice(2) }) }),
    onSuccess: () => {
      toast.success(t("restyleStarted"));
      onClose();
    },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("restyleTitle", { app: app.name, template: name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("restyleExplain")}</p>
          <div className="space-y-1">
            <Label htmlFor="restyle-who">{t("builder")}</Label>
            <select id="restyle-who" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={pick} onChange={(e) => setWho(e.target.value)}>
              <optgroup label={t("employees")}>
                {builders.map((e) => (
                  <option key={e.id} value={`e:${e.id}`}>
                    {e.name} — {e.role}
                  </option>
                ))}
              </optgroup>
              {!!codeDivisions.length && (
                <optgroup label={t("divisions")}>
                  {codeDivisions.map((d) => (
                    <option key={d.id} value={`t:${d.id}`}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="restyle-note">{t("restyleNote")}</Label>
            <Textarea id="restyle-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={go.isPending || !pick} onClick={() => go.mutate()}>
            {t("restyleNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
