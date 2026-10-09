"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Shuffle } from "lucide-react";
import { useTranslations } from "next-intl";
import { BEARDS, GLASSES, HAIR_COLORS, HAIR_STYLES, HATS, resolveLook, SHIRT_COLORS, SKIN_TONES, stableHash, type OfficeLook } from "@wfos/shared/office";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Employee } from "@/lib/hooks";

const LookPreview = dynamic(() => import("@/components/office/look-preview"), { ssr: false, loading: () => <div className="aspect-[1/1.15] w-full animate-pulse rounded-lg bg-muted" /> });

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function Swatches({ label, colors, value, disabled, onPick }: { label: string; colors: readonly string[]; value: number; disabled: boolean; onPick: (i: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {colors.map((c, i) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === i}
            aria-label={`${label} ${i + 1}`}
            disabled={disabled}
            onClick={() => onPick(i)}
            className={cn("size-7 rounded-full border shadow-sm transition disabled:opacity-50", value === i ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "hover:scale-110")}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}

function Choices<T extends string>({ label, options, value, names, disabled, onPick }: { label: string; options: readonly T[]; value: T; names: (o: T) => string; disabled: boolean; onPick: (o: T) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <Button key={o} type="button" size="sm" role="radio" aria-checked={value === o} variant={value === o ? "default" : "outline"} disabled={disabled} onClick={() => onPick(o)}>
            {names(o)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Character editor on the employee page: every choice shows in the preview at once; Save writes it. */
export function LookEditor({ e, company, canEdit }: { e: Employee; company: string; canEdit: boolean }) {
  const t = useTranslations("employees");
  const qc = useQueryClient();
  const reducedMotion = useReducedMotion();
  const saved = resolveLook(e.id, e.look);
  const [look, setLook] = useState<OfficeLook>(saved);
  useEffect(() => setLook(resolveLook(e.id, e.look)), [e.id, e.look]);
  const set = <K extends keyof OfficeLook>(k: K, v: OfficeLook[K]) => setLook((l) => ({ ...l, [k]: v }));
  const save = useMutation({
    mutationFn: (next: OfficeLook | null) => api.patch(`/api/employees/${e.id}`, { look: next }),
    onSuccess: () => {
      toast.success(t("look.saved"));
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
      void qc.invalidateQueries({ queryKey: ["office"] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  const shuffle = () => {
    const h = stableHash(`${e.id}:${Date.now()}`);
    const at = <T,>(arr: readonly T[], s: number) => arr[(h >>> s) % arr.length]!;
    setLook({
      skin: (h >>> 0) % SKIN_TONES.length,
      hair: at(HAIR_STYLES, 3),
      hairColor: (h >>> 7) % HAIR_COLORS.length,
      beard: h % 3 === 0 ? at(BEARDS, 11) : "none",
      glasses: h % 4 === 0 ? at(GLASSES, 13) : "none",
      hat: h % 5 === 0 ? at(HATS, 17) : "none",
      shirt: (h >>> 19) % SHIRT_COLORS.length,
      logo: look.logo,
    });
  };
  const dirty = JSON.stringify(look) !== JSON.stringify(saved);
  const off = !canEdit || save.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("look.label")}</CardTitle>
        <CardDescription>
          {t("look.help")} {canEdit ? null : t("look.adminOnly")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-[minmax(0,240px)_1fr]">
        <div className="mx-auto w-full max-w-60">
          <LookPreview look={look} company={company} label={t("look.preview")} reducedMotion={reducedMotion} />
        </div>
        <div className="space-y-4">
          <Swatches label={t("look.skin")} colors={SKIN_TONES} value={look.skin} disabled={off} onPick={(i) => set("skin", i)} />
          <Choices label={t("look.hair")} options={HAIR_STYLES} value={look.hair} names={(o) => t(`look.hairStyles.${o}`)} disabled={off} onPick={(o) => set("hair", o)} />
          <Swatches label={t("look.hairColor")} colors={HAIR_COLORS} value={look.hairColor} disabled={off} onPick={(i) => set("hairColor", i)} />
          <Choices label={t("look.beard")} options={BEARDS} value={look.beard} names={(o) => t(`look.beards.${o}`)} disabled={off} onPick={(o) => set("beard", o)} />
          <Choices label={t("look.glasses")} options={GLASSES} value={look.glasses} names={(o) => t(`look.glassesTypes.${o}`)} disabled={off} onPick={(o) => set("glasses", o)} />
          <Choices label={t("look.hat")} options={HATS} value={look.hat} names={(o) => t(`look.hats.${o}`)} disabled={off} onPick={(o) => set("hat", o)} />
          <Swatches label={t("look.shirt")} colors={SHIRT_COLORS} value={look.shirt} disabled={off} onPick={(i) => set("shirt", i)} />
          <div className="flex items-center gap-2">
            <Switch id="look-logo" checked={look.logo} disabled={off} onCheckedChange={(v) => set("logo", v)} />
            <Label htmlFor="look-logo">{t("look.logo")}</Label>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(look)}>
                {t("look.save")}
              </Button>
              <Button variant="outline" className="gap-1.5" disabled={save.isPending} onClick={shuffle}>
                <Shuffle className="size-4" /> {t("look.random")}
              </Button>
              {e.look && (
                <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
                  {t("look.reset")}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
