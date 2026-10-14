"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { DIVISION_MAX_PARALLEL, TEAM_RESPONDER_MODES, type TeamResponderMode } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { Team } from "@/lib/hooks";
import { SIGN_COLORS, SIGN_HEX, divisionSignVars } from "@/lib/sign";
import { cn } from "@/lib/utils";

interface Form {
  name: string;
  key: string;
  description: string;
  color: string;
  maxParallel: number;
  dailyBudget: string;
  responderMode: TeamResponderMode;
  sortOrder: number;
  sop: { en: string; id: string };
}

/** what a colour looks like when typed (not translated: a hex value) */
const HEX_EXAMPLE = "#4f7cff";

const fromDivision = (d: Team): Form => ({
  name: d.name,
  key: d.key ?? "",
  description: d.description,
  color: d.color,
  maxParallel: d.maxParallel,
  dailyBudget: d.dailyBudget === null ? "" : String(d.dailyBudget),
  responderMode: d.responderMode,
  sortOrder: d.sortOrder,
  sop: d.sop,
});

/** a division key from a name: lowercase, dashes, starting with a letter (empty when nothing usable is left) */
export function keyFromName(name: string): string {
  const k = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return k.length >= 2 ? k : "";
}

/**
 * Create or edit a division's settings: name, key, colour, description, runs at once, daily budget, who answers in
 * its chat, and the SOP in both languages. Members are changed on the card itself.
 */
export function DivisionDialog({ division, nextOrder, onClose }: { division?: Team; nextOrder: number; onClose: () => void }) {
  const t = useTranslations("teams");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const uid = useId();
  const [f, setF] = useState<Form>(() =>
    division ? fromDivision(division) : { name: "", key: "", description: "", color: "", maxParallel: 1, dailyBudget: "", responderMode: "lead", sortOrder: nextOrder, sop: { en: "", id: "" } },
  );
  const [keyTouched, setKeyTouched] = useState(!!division);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const body = {
    name: f.name.trim(),
    key: f.key || null,
    description: f.description,
    color: f.color,
    maxParallel: f.maxParallel,
    dailyBudget: f.dailyBudget.trim() === "" ? null : Number(f.dailyBudget),
    responderMode: f.responderMode,
    sortOrder: f.sortOrder,
    sop: f.sop,
  };
  const save = useMutation({
    mutationFn: () => (division ? api.patch(`/api/teams/${division.id}`, body) : api.post("/api/teams", { ...body, leadId: null, codeLeadId: null, members: [] })),
    onSuccess: () => {
      toast.success(t("saved"));
      void qc.invalidateQueries({ queryKey: ["teams"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });
  const preview = divisionSignVars(f.color, division?.id ?? "new");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{division ? t("form.editTitle", { name: division.name }) : t("form.createTitle")}</DialogTitle>
          <DialogDescription>{t("form.description")}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <div className="sign flex h-16 items-end rounded-[10px] px-3 pb-2" style={preview} data-state="lit" aria-hidden>
            <span className="font-display truncate text-[1.6rem]">{f.name || t("form.namePlaceholder")}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-name`}>{t("form.name")}</Label>
              <Input
                id={`${uid}-name`}
                value={f.name}
                required
                maxLength={120}
                onChange={(e) => setF((x) => ({ ...x, name: e.target.value, ...(keyTouched ? {} : { key: keyFromName(e.target.value) }) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-key`}>{t("form.key")}</Label>
              <Input
                id={`${uid}-key`}
                value={f.key}
                maxLength={40}
                pattern="[a-z][a-z0-9-]{1,39}"
                className="font-mono"
                onChange={(e) => {
                  setKeyTouched(true);
                  set("key", e.target.value.toLowerCase());
                }}
                aria-describedby={`${uid}-key-help`}
              />
              <p id={`${uid}-key-help`} className="text-xs text-muted-foreground">
                {t("form.keyHelp")}
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-description`}>{t("form.descriptionLabel")}</Label>
              <Textarea id={`${uid}-description`} rows={2} maxLength={2000} value={f.description} onChange={(e) => set("description", e.target.value)} />
            </div>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("form.color")}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => set("color", "")}
                aria-pressed={!f.color}
                className={cn("h-8 rounded-lg border px-2.5 text-xs font-medium", !f.color && "border-foreground")}
              >
                {t("form.colorAuto")}
              </button>
              {SIGN_COLORS.map((c) => {
                const hex = SIGN_HEX[c];
                const on = f.color.toLowerCase() === hex;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set("color", hex)}
                    aria-pressed={on}
                    aria-label={t(`form.colors.${c}`)}
                    title={t(`form.colors.${c}`)}
                    className={cn("sign flex size-8 items-center justify-center rounded-lg", on && "ring-2 ring-foreground ring-offset-2 ring-offset-background")}
                    style={divisionSignVars(hex, c)}
                    data-state="lit"
                  >
                    {on && <Check className="size-4" aria-hidden />}
                  </button>
                );
              })}
              <Input
                aria-label={t("form.colorHex")}
                value={f.color}
                placeholder={HEX_EXAMPLE}
                maxLength={7}
                pattern="#[0-9a-fA-F]{6}"
                className="h-8 w-28 font-mono text-xs"
                onChange={(e) => set("color", e.target.value.trim())}
              />
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-parallel`}>{t("form.maxParallel")}</Label>
              <Input id={`${uid}-parallel`} type="number" min={1} max={DIVISION_MAX_PARALLEL} value={f.maxParallel} onChange={(e) => set("maxParallel", Math.max(1, Math.min(DIVISION_MAX_PARALLEL, Number(e.target.value) || 1)))} />
              <p className="text-xs text-muted-foreground">{t("form.maxParallelHelp")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-budget`}>{t("form.dailyBudget")}</Label>
              <Input id={`${uid}-budget`} type="number" min={0} value={f.dailyBudget} placeholder={t("form.dailyBudgetNone")} onChange={(e) => set("dailyBudget", e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("form.dailyBudgetHelp")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-order`}>{t("form.order")}</Label>
              <Input id={`${uid}-order`} type="number" min={0} max={10000} value={f.sortOrder} onChange={(e) => set("sortOrder", Math.max(0, Number(e.target.value) || 0))} />
              <p className="text-xs text-muted-foreground">{t("form.orderHelp")}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-responder`}>{t("responder.title")}</Label>
            <select id={`${uid}-responder`} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.responderMode} onChange={(e) => set("responderMode", e.target.value as TeamResponderMode)}>
              {TEAM_RESPONDER_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`responder.modes.${m}.label`)} — {t(`responder.modes.${m}.description`)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("responder.help")}</p>
          </div>

          <div className="space-y-1.5">
            <div className="text-sm font-medium">{t("form.sop")}</div>
            <p className="text-xs text-muted-foreground">{t("form.sopHelp")}</p>
            <Tabs defaultValue="id">
              <TabsList>
                <TabsTrigger value="id">{t("form.sopId")}</TabsTrigger>
                <TabsTrigger value="en">{t("form.sopEn")}</TabsTrigger>
              </TabsList>
              {(["id", "en"] as const).map((lang) => (
                <TabsContent key={lang} value={lang} className="mt-2">
                  <Textarea
                    aria-label={lang === "id" ? t("form.sopId") : t("form.sopEn")}
                    rows={10}
                    maxLength={20000}
                    className="font-mono text-xs"
                    value={f.sop[lang]}
                    onChange={(e) => set("sop", { ...f.sop, [lang]: e.target.value })}
                  />
                </TabsContent>
              ))}
            </Tabs>
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-2.5 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!f.name.trim() || save.isPending}>
            {division ? t("form.save") : t("form.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
