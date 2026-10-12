"use client";

import { useId, useState } from "react";
import Link from "@/lib/nav";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import type { WebhookDeliveryStatus } from "@wfos/shared";
import { useStepUp } from "@/components/account/step-up";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";

interface Webhook {
  id: string;
  name: string;
  url: string;
  assigneeId: string | null;
  assigneeName: string | null;
  teamId: string | null;
  teamName: string | null;
  briefTemplate: string;
  dryRun: boolean;
  enabled: boolean;
  lastFiredAt: string | null;
  counts: Record<WebhookDeliveryStatus, number>;
  lastDelivery: { status: WebhookDeliveryStatus; receivedAt: string } | null;
}

interface Delivery {
  id: string;
  status: WebhookDeliveryStatus;
  taskId: string | null;
  error: string | null;
  idempotencyKey: string | null;
  payloadExcerpt: string;
  receivedAt: string;
}

const QK = ["settings", "webhooks"] as const;

const TONE: Record<WebhookDeliveryStatus, "default" | "secondary" | "destructive" | "outline"> = {
  accepted: "default",
  duplicate: "secondary",
  rejected: "outline",
  failed: "destructive",
};

/** The curl line for a webhook (the secret is only known right after creation or rotation). */
function curlExample(url: string, secret: string) {
  // i18n-ignore: a shell command, the same in every language
  return `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer ${secret}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-1001' \\\n  -d '{"title":"Order #1001","total":125000}'`;
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    // clipboard blocked (http, permissions): the text stays selectable in the dialog
  }
}

/** "e:<id>" / "t:<id>" for the one target select. */
function targetValue(w: { assigneeId: string | null; teamId: string | null }) {
  return w.assigneeId ? `e:${w.assigneeId}` : w.teamId ? `t:${w.teamId}` : "";
}
function targetBody(v: string) {
  return v.startsWith("t:") ? { assigneeId: null, teamId: v.slice(2) } : { assigneeId: v.slice(2) || null, teamId: null };
}

/** Inbound webhook triggers: an external system creates a task by POSTing to a URL with a secret. */
export function WebhooksSettings({ owner, admin }: { owner: boolean; admin: boolean }) {
  const t = useTranslations("webhooks");
  const tc = useTranslations("common");
  const f = useFormat();
  const qc = useQueryClient();
  const withStepUp = useStepUp();
  const list = useQuery({ queryKey: QK, queryFn: () => api.get<{ webhooks: Webhook[] }>("/api/settings/webhooks").then((r) => r.webhooks), enabled: admin });
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: () => api.get<{ employees: { id: string; name: string; role: string }[] }>("/api/employees").then((r) => r.employees),
    enabled: admin,
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => api.get<{ teams: { id: string; name: string }[] }>("/api/teams").then((r) => r.teams), enabled: admin });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", target: "", briefTemplate: "", dryRun: false });
  const [revealed, setRevealed] = useState<{ name: string; url: string; secret: string } | null>(null);
  const [drawer, setDrawer] = useState<Webhook | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: QK });
  const onError = (e: unknown) => toast.error((e as Error).message);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ secret: string; url: string; webhook: { name: string } }>("/api/settings/webhooks", {
        name: form.name,
        briefTemplate: form.briefTemplate,
        dryRun: form.dryRun,
        ...targetBody(form.target),
      }),
    onSuccess: (r) => {
      setCreating(false);
      setForm({ name: "", target: "", briefTemplate: "", dryRun: false });
      setRevealed({ name: r.webhook.name, url: r.url, secret: r.secret });
      toast.success(t("created"));
      refresh();
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/settings/webhooks/${id}`, body),
    onSuccess: refresh,
    onError,
  });
  const rotate = useMutation({
    mutationFn: (w: Webhook) =>
      withStepUp(() => api.post<{ secret: string; url: string }>(`/api/settings/webhooks/${w.id}/rotate-secret`)).then((r) => (r ? { ...r, name: w.name } : undefined)),
    onSuccess: (r) => {
      if (!r) return;
      setRevealed(r);
      toast.success(t("rotated"));
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/settings/webhooks/${id}`),
    onSuccess: () => {
      toast.success(t("deleted"));
      refresh();
    },
    onError,
  });

  if (!admin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("adminOnly")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const targetOptions = (
    <>
      <option value="">{tc("selectPlaceholder")}</option>
      {!!employees.data?.length && (
        <optgroup label={t("employees")}>
          {employees.data.map((e) => (
            <option key={e.id} value={`e:${e.id}`}>
              {e.name} · {e.role}
            </option>
          ))}
        </optgroup>
      )}
      {!!teams.data?.length && (
        <optgroup label={t("teams")}>
          {teams.data.map((x) => (
            <option key={x.id} value={`t:${x.id}`}>
              {x.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          {t("new")}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-sm">
          {list.data?.map((w) => (
            <li key={w.id} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{w.name}</span>
                {w.dryRun && <Badge variant="secondary">{t("dryRun")}</Badge>}
                {w.lastDelivery && <Badge variant={TONE[w.lastDelivery.status]}>{t(`status.${w.lastDelivery.status}`)}</Badge>}
                <span className="text-xs text-muted-foreground">{w.lastFiredAt ? t("lastFired", { time: f.dateTime(w.lastFiredAt) }) : t("neverFired")}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{w.url}</code>
                <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={tc("copy")} onClick={() => void copy(w.url, tc("copied"))}>
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={`wh-target-${w.id}`} className="text-xs text-muted-foreground">
                  {t("target")}
                </Label>
                <select
                  id={`wh-target-${w.id}`}
                  className="h-8 max-w-full rounded-md border bg-background px-2 text-sm"
                  value={targetValue(w)}
                  onChange={(e) => e.target.value && patch.mutate({ id: w.id, body: targetBody(e.target.value) })}
                >
                  {targetOptions}
                </select>
                {!w.assigneeId && !w.teamId && <span className="text-xs text-destructive">{t("targetMissing")}</span>}
              </div>
              <p className="text-xs text-muted-foreground">{t("counts", w.counts)}</p>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2">
                  <Switch checked={w.enabled} onCheckedChange={(v) => patch.mutate({ id: w.id, body: { enabled: v } })} />
                  {t("enabled")}
                </label>
                <label className="flex items-center gap-2">
                  <Switch checked={w.dryRun} onCheckedChange={(v) => patch.mutate({ id: w.id, body: { dryRun: v } })} />
                  {t("dryRun")}
                </label>
                <div className="ml-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" onClick={() => setDrawer(w)}>
                    {t("deliveries")}
                  </Button>
                  {owner && (
                    <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => confirm(t("rotateConfirm", { name: w.name })) && rotate.mutate(w)}>
                      {t("rotate")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(t("deleteConfirm", { name: w.name })) && remove.mutate(w.id)}>
                    {tc("delete")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
          {list.data && !list.data.length && <li className="text-muted-foreground">{t("empty")}</li>}
        </ul>
      </CardContent>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="wh-name">{tc("name")}</Label>
              <Input id="wh-name" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-target">{t("target")}</Label>
              <select id="wh-target" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
                {targetOptions}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-brief">{t("briefTemplate")}</Label>
              <Textarea
                id="wh-brief"
                rows={4}
                maxLength={8000}
                value={form.briefTemplate}
                placeholder={t("briefTemplatePlaceholder")}
                onChange={(e) => setForm({ ...form, briefTemplate: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("briefTemplateHelp")}</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Switch checked={form.dryRun} onCheckedChange={(v) => setForm({ ...form, dryRun: v })} className="mt-0.5" />
              <span>
                {t("dryRun")}
                <span className="block text-xs text-muted-foreground">{t("dryRunHelp")}</span>
              </span>
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                {tc("cancel")}
              </Button>
              <Button disabled={!form.name.trim() || !form.target || create.isPending}>{tc("create")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("secretTitle")}</DialogTitle>
            <DialogDescription>{revealed?.name}</DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="min-w-0 space-y-3 text-sm">
              <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{t("secretOnce")}</p>
              <SecretRow label={t("url")} value={revealed.url} copyLabel={tc("copy")} copied={tc("copied")} />
              <SecretRow label={t("secret")} value={revealed.secret} copyLabel={tc("copy")} copied={tc("copied")} />
              <div role="group" aria-labelledby="webhook-example-label" className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label id="webhook-example-label">{t("example")}</Label>
                  <Button size="sm" variant="ghost" onClick={() => void copy(curlExample(revealed.url, revealed.secret), tc("copied"))}>
                    <Copy className="size-3.5" />
                    {tc("copy")}
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{curlExample(revealed.url, revealed.secret)}</pre>
                <p className="text-xs text-muted-foreground">{t("exampleHelp")}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t("deliveries")}</SheetTitle>
            <SheetDescription>{drawer ? t("deliveriesDescription", { name: drawer.name }) : null}</SheetDescription>
          </SheetHeader>
          {drawer && <Deliveries id={drawer.id} />}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function SecretRow({ label, value, copyLabel, copied }: { label: string; value: string; copyLabel: string; copied: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" size="icon" variant="outline" className="shrink-0" aria-label={copyLabel} onClick={() => void copy(value, copied)}>
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function Deliveries({ id }: { id: string }) {
  const t = useTranslations("webhooks");
  const f = useFormat();
  const { data } = useQuery({
    queryKey: [...QK, id, "deliveries"],
    queryFn: () => api.get<{ deliveries: Delivery[]; rateLimitedToday: number }>(`/api/settings/webhooks/${id}/deliveries`),
  });
  const errorText = (code: string) => (t.has(`error.${code}`) ? t(`error.${code}`) : code);
  return (
    <ul className="space-y-2 px-4 pb-4 text-sm">
      {!!data?.rateLimitedToday && <li className="text-xs text-muted-foreground">{t("rateLimitedToday", { count: data.rateLimitedToday })}</li>}
      {data?.deliveries.map((d) => (
        <li key={d.id} className="space-y-1.5 rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={TONE[d.status]}>{t(`status.${d.status}`)}</Badge>
            <span className="text-xs text-muted-foreground">{f.dateTime(d.receivedAt)}</span>
            {d.idempotencyKey && <code className="max-w-48 truncate text-xs text-muted-foreground">{d.idempotencyKey}</code>}
            {d.taskId && (
              <Link href={`/tasks/${d.taskId}`} className="ml-auto text-xs text-primary underline-offset-4 hover:underline">
                {t("openTask")}
              </Link>
            )}
          </div>
          {d.error && <p className="text-xs text-destructive">{errorText(d.error)}</p>}
          {d.payloadExcerpt && <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">{d.payloadExcerpt}</pre>}
        </li>
      ))}
      {data && !data.deliveries.length && <li className="text-muted-foreground">{t("noDeliveries")}</li>}
    </ul>
  );
}
