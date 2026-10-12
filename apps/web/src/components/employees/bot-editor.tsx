"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { BotAvatar, type BotMood } from "@/components/ui/bot-avatar";
import { api } from "@/lib/api";
import { useEmployees, type Employee } from "@/lib/hooks";
import { BOT_EXPRESSIONS, BOT_SHAPES, SIGN_COLORS, employeeLooks, formatBotChoice, parseBotChoice, type BotChoice } from "@/lib/sign";
import { cn } from "@/lib/utils";

const MOODS: BotMood[] = ["idle", "working", "approval", "fault", "off"];

/** A row of radio tiles, "Automatic" first. */
function Picker<T extends string>({ label, help, options, value, disabled, onPick, tile, name, auto }: {
  label: string;
  help?: string;
  options: readonly T[];
  value: T | undefined;
  disabled: boolean;
  onPick: (v: T | undefined) => void;
  tile: (o: T) => ReactNode;
  name: (o: T) => string;
  auto: string;
}) {
  const labelId = useId();
  const cls = (on: boolean) =>
    cn(
      "flex min-w-16 flex-col items-center gap-1 rounded-xl border px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-50",
      on ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:bg-accent",
    );
  return (
    <div className="space-y-1.5">
      <Label id={labelId}>{label}</Label>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={labelId}>
        <button type="button" role="radio" aria-checked={value === undefined} disabled={disabled} onClick={() => onPick(undefined)} className={cls(value === undefined)}>
          <span className="grid size-8 place-items-center text-base text-muted-foreground" aria-hidden>
            ✦
          </span>
          {auto}
        </button>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} disabled={disabled} onClick={() => onPick(o)} className={cls(value === o)}>
            <span className="size-8" aria-hidden>
              {tile(o)}
            </span>
            {name(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Bot avatar editor on the employee page: shape, sign colour and rest expression, each one either picked or left
 * automatic. The preview shows the result as it will be dealt (automatic parts avoid the other employees' picks).
 */
export function BotEditor({ e, canEdit }: { e: Employee; canEdit: boolean }) {
  const t = useTranslations("employees.bot");
  const qc = useQueryClient();
  const { data: emps } = useEmployees();
  const [choice, setChoice] = useState<BotChoice>(() => parseBotChoice(e.avatar));
  useEffect(() => setChoice(parseBotChoice(e.avatar)), [e.avatar]);
  const [mood, setMood] = useState<BotMood>("idle");
  const next = formatBotChoice(choice);
  const saved = formatBotChoice(parseBotChoice(e.avatar));

  // what the bot will look like once saved: this employee's draft among everyone else's choices
  const look = useMemo(() => {
    const others = (emps ?? []).filter((x) => x.id !== e.id);
    const all = employeeLooks([...others, { id: e.id, avatar: next }]);
    return { shape: all.shapes.get(e.id)!, color: all.colors.get(e.id), expression: all.expressions.get(e.id) };
  }, [emps, e.id, next]);

  const save = useMutation({
    mutationFn: (avatar: string) => api.patch(`/api/employees/${e.id}`, { avatar }),
    onSuccess: () => {
      toast.success(t("saved"));
      void qc.invalidateQueries({ queryKey: ["employees"] });
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
      void qc.invalidateQueries({ queryKey: ["office"] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  const off = !canEdit || save.isPending;
  const set = <K extends keyof BotChoice>(k: K, v: BotChoice[K]) => setChoice((c) => ({ ...c, [k]: v }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("label")}</CardTitle>
        <CardDescription>
          {t("help")} {canEdit ? null : t("adminOnly")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-[minmax(0,220px)_1fr]">
        <div className="space-y-3">
          <div className="mx-auto grid aspect-square w-full max-w-52 place-items-center rounded-2xl border bg-muted/40 p-8" role="img" aria-label={`${t("preview")}: ${e.name}`}>
            <BotAvatar shape={look.shape} color={look.color} expression={look.expression} mood={mood} seed={e.id} />
          </div>
          <div className="flex flex-wrap justify-center gap-1" role="radiogroup" aria-label={t("preview")}>
            {MOODS.map((m) => (
              <Button key={m} type="button" size="sm" variant={mood === m ? "default" : "outline"} role="radio" aria-checked={mood === m} className="h-7 px-2 text-xs" onClick={() => setMood(m)}>
                {t(`moods.${m}`)}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-5">
          <Picker
            label={t("shape")}
            options={BOT_SHAPES}
            value={choice.shape}
            disabled={off}
            onPick={(v) => set("shape", v)}
            tile={(o) => <BotAvatar shape={o} color={look.color} expression={look.expression} seed={`${e.id}:${o}`} />}
            name={(o) => t(`shapes.${o}`)}
            auto={t("auto")}
          />
          <Picker
            label={t("color")}
            help={t("colorHelp")}
            options={SIGN_COLORS}
            value={choice.color}
            disabled={off}
            onPick={(v) => set("color", v)}
            tile={(o) => <span className="mx-auto block size-7 rounded-full shadow-sm" style={{ background: `var(--sign-${o})` }} />}
            name={(o) => t(`colors.${o}`)}
            auto={t("auto")}
          />
          <Picker
            label={t("expression")}
            options={BOT_EXPRESSIONS}
            value={choice.expression}
            disabled={off}
            onPick={(v) => set("expression", v)}
            tile={(o) => <BotAvatar shape={look.shape} color={look.color} expression={o} seed={`${e.id}:${o}`} />}
            name={(o) => t(`expressions.${o}`)}
            auto={t("auto")}
          />
          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button disabled={next === saved || save.isPending} onClick={() => save.mutate(next)}>
                {t("save")}
              </Button>
              {saved && (
                <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate("")}>
                  {t("reset")}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
