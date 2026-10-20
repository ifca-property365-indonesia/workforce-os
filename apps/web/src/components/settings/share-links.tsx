"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Eye, Trash2 } from "lucide-react";
import { useStepUp } from "@/components/account/step-up";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";

interface Link {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  opens: number;
}
const HOURS = [2, 24, 72, 168] as const;

/**
 * View-only links (Owner): someone without an account looks at the workspace (dashboard, office, employees,
 * divisions, tasks, goals, apps) until the link expires; nothing can be changed. Created with a step-up, shown once.
 */
export function ShareLinksSettings() {
  const t = useTranslations("settings.shareLinks");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const uid = useId();
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState<number>(24);
  const [created, setCreated] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["share-links"], queryFn: () => api.get<{ links: Link[] }>("/api/share-links") });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["share-links"] });
  const create = useMutation({
    mutationFn: () => withStepUp(() => api.post<{ url: string }>("/api/share-links", { label: label.trim(), hours })),
    onSuccess: (r) => {
      if (!r) return;
      setCreated(r.url);
      setLabel("");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/share-links/${id}`),
    onSuccess: () => {
      toast.success(t("revoked"));
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const state = (l: Link) => (l.revokedAt ? "revoked" : new Date(l.expiresAt).getTime() <= Date.now() ? "expired" : "active");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye className="size-4" aria-hidden /> {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{t("description")}</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor={`${uid}-label`}>{t("label")}</Label>
            <Input id={`${uid}-label`} required maxLength={80} value={label} placeholder={t("labelPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-hours`}>{t("valid")}</Label>
            <select id={`${uid}-hours`} className="h-9 rounded-md border bg-background px-2 text-sm" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {t(`hours.${h}`)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={create.isPending || !label.trim()}>
            {t("create")}
          </Button>
        </form>
        {created && (
          <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3">
            <p className="font-medium">{t("createdOnce")}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs select-all">{created}</code>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(created)
                    .then(() => toast.success(tc("copied")))
                    .catch(() => {})
                }
              >
                <Copy className="size-3.5" aria-hidden /> {tc("copy")}
              </Button>
            </div>
          </div>
        )}
        {!!data?.links.length && (
          <ul className="divide-y rounded-lg border">
            {data.links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium">{l.label}</span>
                <span className="rounded bg-secondary px-1.5 text-xs">{t(`state.${state(l)}`)}</span>
                <span className="flex-1 text-xs text-muted-foreground">
                  {[t("until", { when: f.dateTime(l.expiresAt) }), t("opens", { count: l.opens }), l.lastUsedAt && t("lastUsed", { when: f.ago(l.lastUsedAt) })].filter(Boolean).join(" · ")}
                </span>
                {state(l) === "active" && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-destructive" disabled={revoke.isPending} onClick={() => confirm(t("revokeConfirm", { label: l.label })) && revoke.mutate(l.id)}>
                    <Trash2 className="size-3.5" aria-hidden /> {t("revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
