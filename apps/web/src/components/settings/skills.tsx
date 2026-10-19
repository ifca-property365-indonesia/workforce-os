"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowUpCircle, ExternalLink, Eye, Pencil, Plus, ShieldAlert, Trash2, Upload } from "lucide-react";
import { isReservedSkillSlug, SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX, SKILL_SLUG_MAX, SKILL_SLUG_RE, utf8Bytes, type SkillSource } from "@wfos/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useDebounced } from "@/components/routines/schedule-preview";
import { api } from "@/lib/api";
import { parseSkillMarkdown } from "@/lib/skill-md";
import { cn } from "@/lib/utils";
import { SkillAuditCard, SkillUpdateDialog } from "./skill-audit";

export interface SkillRow {
  id: string;
  slug: string;
  description: string;
  body?: string;
  bodyChars: number;
  source: SkillSource;
  enabled: boolean;
  untrusted: boolean;
  /** C4: a catalog skill's repository, commit and license */
  origin?: { source: string; path: string; commit: string; license: string | null; url: string } | null;
  /** a newer commit of a catalog skill (applied only by an Admin) */
  updateAvailable?: string | null;
  fileCount?: number;
  employeeCount: number;
}

export const SKILLS_QK = ["skills"] as const;
export const useSkills = () => useQuery({ queryKey: SKILLS_QK, queryFn: () => api.get<{ skills: SkillRow[] }>("/api/skills").then((r) => r.skills) });

/** The SKILL.md preview is parsed this long after the last keystroke. */
const PARSE_DEBOUNCE_MS = 300;

/** Largest SKILL.md the upload accepts (body + frontmatter). */
const UPLOAD_MAX = SKILL_BODY_MAX + 8 * 1024;

const SOURCE_TONE: Record<SkillSource, string> = {
  user: "",
  learned: "border-[var(--sign-biru)]/40 text-[var(--sign-biru)] dark:text-[color-mix(in_srgb,var(--sign-biru)_60%,white)]",
  import: "border-[var(--sign-ungu)]/40 text-[var(--sign-ungu)] dark:text-[color-mix(in_srgb,var(--sign-ungu)_55%,white)]",
  builtin: "border-success/40 text-success",
  catalog: "border-[var(--sign-biru)]/40 text-[var(--sign-biru)] dark:text-[color-mix(in_srgb,var(--sign-biru)_60%,white)]",
};

export function SkillSourceBadge({ source }: { source: SkillSource }) {
  const t = useTranslations("skills");
  return (
    <Badge variant="outline" className={SOURCE_TONE[source]} title={t(`sourceHelp.${source}`)}>
      {t(`source.${source}`)}
    </Badge>
  );
}

export function UntrustedBadge() {
  const t = useTranslations("skills");
  return (
    <Badge variant="outline" className="border-warning/50 text-warning" title={t("untrustedHelp")}>
      <ShieldAlert /> {t("untrusted")}
    </Badge>
  );
}

/** Toasts for what the server let through but wants a person to look at. */
function useSaveNotes() {
  const t = useTranslations("skills");
  const tp = useTranslations("packages");
  return (r: { warnings?: string[]; ignoredFields?: string[] }) => {
    if (r.warnings?.length) toast.warning(t("mediumWarnings", { rules: r.warnings.map((w) => (tp.has(`rules.${w}`) ? tp(`rules.${w}`) : w)).join(", ") }));
    if (r.ignoredFields?.length) toast.info(t("ignoredFields", { fields: r.ignoredFields.join(", ") }));
  };
}

type EditorState = { kind: "new"; markdown?: string } | { kind: "edit"; skill: SkillRow } | { kind: "view"; skill: SkillRow };

/** New skill (form or pasted SKILL.md), edit (description and body), or read-only view. */
function SkillEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const t = useTranslations("skills");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const notes = useSaveNotes();
  const existing = state.kind === "new" ? null : state.skill;
  const readOnly = state.kind === "view";
  // the list only carries bodies for admins; a viewer (and an edit opened before the list loaded) fetches the skill
  const { data: full } = useQuery({
    queryKey: ["skill", existing?.id],
    enabled: !!existing && existing.body === undefined,
    queryFn: () => api.get<{ skill: SkillRow }>(`/api/skills/${existing!.id}`).then((r) => r.skill),
  });
  const [mode, setMode] = useState<"form" | "markdown">(state.kind === "new" && state.markdown !== undefined ? "markdown" : "form");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [body, setBody] = useState<string | null>(existing?.body ?? null);
  const [markdown, setMarkdown] = useState(state.kind === "new" ? (state.markdown ?? "") : "");
  const bodyText = body ?? full?.body ?? "";
  const bodyBytes = useMemo(() => utf8Bytes(bodyText), [bodyText]);
  // parsed after a pause in typing, not on every keystroke; saving waits until the preview matches the text
  const debouncedMarkdown = useDebounced(markdown, PARSE_DEBOUNCE_MS);
  const parsePending = debouncedMarkdown !== markdown;
  const parsed = useMemo(() => (mode === "markdown" && debouncedMarkdown.trim() ? parseSkillMarkdown(debouncedMarkdown) : null), [mode, debouncedMarkdown]);
  const slugReserved = isReservedSkillSlug(slug);
  const slugOk = SKILL_SLUG_RE.test(slug) && slug.length <= SKILL_SLUG_MAX && !slugReserved;
  const parsedReserved = !!parsed?.ok && isReservedSkillSlug(parsed.name);
  // a viewer (or a member) gets the skill without its instructions
  const bodyHidden = readOnly && body === null && !!full && full.body === undefined;

  const save = useMutation({
    mutationFn: () => {
      if (existing) return api.patch<{ warnings?: string[] }>(`/api/skills/${existing.id}`, { description, body: bodyText });
      return api.post<{ warnings?: string[]; ignoredFields?: string[]; skill: { slug: string } }>("/api/skills", mode === "markdown" ? { markdown } : { slug, description, body: bodyText });
    },
    onSuccess: (r) => {
      toast.success(existing ? t("saved") : t("created", { slug: (r as { skill?: { slug: string } }).skill?.slug ?? slug }));
      notes(r);
      void qc.invalidateQueries({ queryKey: SKILLS_QK });
      if (existing) void qc.invalidateQueries({ queryKey: ["skill", existing.id] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const canSave =
    !readOnly &&
    !save.isPending &&
    (mode === "markdown"
      ? !parsePending && !!parsed?.ok && !parsedReserved
      : (existing || slugOk) && !!description.trim() && !!bodyText.trim() && description.length <= SKILL_DESCRIPTION_MAX && bodyBytes <= SKILL_BODY_MAX);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{existing ? t("editor.titleEdit", { slug: existing.slug }) : t("editor.titleNew")}</DialogTitle>
          {!readOnly && <DialogDescription>{t("editor.description")}</DialogDescription>}
        </DialogHeader>
        {existing && (
          <div className="flex flex-wrap items-center gap-2">
            <SkillSourceBadge source={existing.source} />
            {existing.untrusted && <UntrustedBadge />}
          </div>
        )}
        {existing?.untrusted && !readOnly && <p className="text-xs text-warning">{t("editor.untrustedKept")}</p>}
        {state.kind === "new" && (
          <div className="inline-flex w-fit rounded-md border p-0.5 text-sm">
            {(["form", "markdown"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={cn("rounded px-3 py-1", mode === m ? "bg-muted font-medium" : "text-muted-foreground")}>
                {m === "form" ? t("editor.modeForm") : t("editor.modeMarkdown")}
              </button>
            ))}
          </div>
        )}
        {mode === "markdown" ? (
          <div className="space-y-1.5">
            <Label htmlFor="skill-md">{t("editor.markdown")}</Label>
            <Textarea id="skill-md" rows={16} value={markdown} onChange={(e) => setMarkdown(e.target.value)} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground">{t("editor.markdownHelp")}</p>
            {parsed &&
              (parsed.ok ? (
                <p className="text-xs text-success">{t("editor.parsed", { slug: parsed.name, description: parsed.description })}</p>
              ) : (
                <p className="text-xs text-destructive">{t("editor.parseError", { reason: parsed.error, line: parsed.line ?? 0 })}</p>
              ))}
            {parsed?.ok && !SKILL_SLUG_RE.test(parsed.name) && <p className="text-xs text-destructive">{t("editor.invalidSlug")}</p>}
            {parsedReserved && parsed?.ok && <p className="text-xs text-destructive">{t("editor.reservedSlug", { slug: parsed.name })}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="skill-slug">{t("editor.slug")}</Label>
              <Input id="skill-slug" value={slug} disabled={!!existing} maxLength={SKILL_SLUG_MAX} onChange={(e) => setSlug(e.target.value.toLowerCase())} className="font-mono text-sm" />
              {!existing && (
                <p className={cn("text-xs", slug && !slugOk ? "text-destructive" : "text-muted-foreground")}>
                  {slugReserved ? t("editor.reservedSlug", { slug }) : slug && !slugOk ? t("editor.invalidSlug") : t("editor.slugHelp")}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-description">{t("editor.descriptionLabel")}</Label>
              <Textarea id="skill-description" rows={2} value={description} readOnly={readOnly} onChange={(e) => setDescription(e.target.value)} />
              {!readOnly && (
                <p className={cn("text-xs", description.length > SKILL_DESCRIPTION_MAX ? "text-destructive" : "text-muted-foreground")}>
                  {t("editor.descriptionHelp", { count: description.length, max: SKILL_DESCRIPTION_MAX })}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-body">{t("editor.body")}</Label>
              {bodyHidden ? (
                <p className="text-xs text-muted-foreground">{t("editor.bodyAdminOnly")}</p>
              ) : readOnly ? (
                <pre id="skill-body" className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">
                  {bodyText}
                </pre>
              ) : (
                <>
                  <Textarea id="skill-body" rows={16} value={bodyText} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
                  <p className={cn("text-xs", bodyBytes > SKILL_BODY_MAX ? "text-destructive" : "text-muted-foreground")}>{t("editor.bodyHelp", { count: bodyBytes, max: SKILL_BODY_MAX })}</p>
                </>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {readOnly ? tc("close") : tc("cancel")}
          </Button>
          {!readOnly && (
            <Button disabled={!canSave} onClick={() => save.mutate()}>
              {t("editor.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → Skills: every SKILL.md of the workspace. Owners and Admins add, edit, switch and delete them. */
export function SkillsSettings({ admin }: { admin: boolean }) {
  const t = useTranslations("skills");
  const qc = useQueryClient();
  const { data } = useSkills();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [updating, setUpdating] = useState<SkillRow | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const toggle = useMutation({
    mutationFn: (v: { s: SkillRow; enabled: boolean }) => api.patch(`/api/skills/${v.s.id}`, { enabled: v.enabled }),
    onSuccess: (_r, v) => {
      toast.success(v.enabled ? t("enabledToast", { slug: v.s.slug }) : t("disabledToast", { slug: v.s.slug }));
      void qc.invalidateQueries({ queryKey: SKILLS_QK });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/skills/${id}`),
    onSuccess: () => {
      toast.success(t("deleted"));
      void qc.invalidateQueries({ queryKey: SKILLS_QK });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const upload = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    if (file.size > UPLOAD_MAX) return void toast.error(t("uploadTooLarge", { max: Math.round(UPLOAD_MAX / 1024) }));
    try {
      // opened in the editor first: the admin reads it and saves it
      setEditor({ kind: "new", markdown: await file.text() });
    } catch {
      toast.error(t("uploadNotText"));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("intro")}</CardDescription>
          <ul className="list-inside list-disc text-xs text-muted-foreground">
            <li>{t("untrustedFilesNote")}</li>
            <li>{t("reservedNote")}</li>
          </ul>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {admin ? (
            <>
              <Button size="sm" className="gap-1.5" onClick={() => setEditor({ kind: "new" })}>
                <Plus className="size-3.5" /> {t("add")}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => fileInput.current?.click()}>
                <Upload className="size-3.5" /> {t("upload")}
              </Button>
              <input ref={fileInput} type="file" accept=".md,.markdown,text/markdown,text/plain" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
          )}
        </CardContent>
      </Card>
      {admin && <SkillAuditCard />}
      {data && !data.length && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
      {data?.map((s) => (
        <Card key={s.id} className={cn(!s.enabled && "opacity-70")}>
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm font-medium">{s.slug}</code>
                <SkillSourceBadge source={s.source} />
                {s.untrusted && <UntrustedBadge />}
                {s.updateAvailable && (
                  <Badge variant="outline" className="border-warning/50 text-warning">
                    <ArrowUpCircle /> {t("updateAvailable")}
                  </Badge>
                )}
              </div>
              <p className="break-words text-sm text-muted-foreground">{s.description}</p>
              {s.origin && (
                <p className="break-all text-xs text-muted-foreground">
                  <a href={s.origin.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:underline">
                    {s.origin.source}/{s.origin.path} <ExternalLink className="size-3" />
                  </a>{" "}
                  · <code>{s.origin.commit.slice(0, 8)}</code> · {t("licenseLabel", { license: s.origin.license ?? "—" })}
                  {s.fileCount ? ` · ${t("fileCount", { count: s.fileCount })}` : ""}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("assignedCount", { count: s.employeeCount })} · {t("chars", { count: s.bodyChars })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {admin && s.updateAvailable && (
                <Button size="sm" variant="outline" className="gap-1" onClick={() => setUpdating(s)}>
                  <ArrowUpCircle className="size-3.5" /> {t("reviewUpdate")}
                </Button>
              )}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch checked={s.enabled} disabled={!admin || toggle.isPending} aria-label={t("enable", { slug: s.slug })} onCheckedChange={(v) => toggle.mutate({ s, enabled: v })} />
                {t("enabled")}
              </label>
              {admin ? (
                <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditor({ kind: "edit", skill: s })}>
                  <Pencil className="size-3.5" /> {t("edit")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditor({ kind: "view", skill: s })}>
                  <Eye className="size-3.5" /> {t("view")}
                </Button>
              )}
              {admin && (
                <Button size="sm" variant="ghost" className="text-destructive" aria-label={t("delete")} onClick={() => confirm(t("deleteConfirm", { slug: s.slug })) && remove.mutate(s.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
      {updating && <SkillUpdateDialog key={updating.id} skill={updating} onClose={() => setUpdating(null)} />}
      {editor && <SkillEditor key={editor.kind === "new" ? "new" : editor.skill.id} state={editor} onClose={() => setEditor(null)} />}
    </div>
  );
}
