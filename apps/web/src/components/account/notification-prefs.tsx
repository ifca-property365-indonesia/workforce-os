"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { NotificationChannel, NotificationKind } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Avatar } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useEmployees } from "@/lib/hooks";

interface Prefs {
  kinds: NotificationKind[];
  channelNames: NotificationChannel[];
  channels: Record<NotificationKind, Record<NotificationChannel, boolean>>;
  mutedEmployeeIds: string[];
}

/** Account → which notifications reach me where (kinds × channels), and employees I do not want to hear about. */
export function NotificationPrefsCard() {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notification-prefs"], queryFn: () => api.get<Prefs>("/api/me/notification-prefs") });
  const { data: emps } = useEmployees();
  const [draft, setDraft] = useState<Pick<Prefs, "channels" | "mutedEmployeeIds"> | null>(null);
  useEffect(() => {
    if (data) setDraft({ channels: data.channels, mutedEmployeeIds: data.mutedEmployeeIds });
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.put<Prefs>("/api/me/notification-prefs", draft),
    onSuccess: (r) => {
      qc.setQueryData(["notification-prefs"], r);
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success(t("notifications.saved"));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify({ channels: data.channels, mutedEmployeeIds: data.mutedEmployeeIds });
  const setCell = (k: NotificationKind, c: NotificationChannel, v: boolean) => setDraft({ ...draft, channels: { ...draft.channels, [k]: { ...draft.channels[k], [c]: v } } });
  const toggleMute = (id: string, muted: boolean) =>
    setDraft({ ...draft, mutedEmployeeIds: muted ? [...draft.mutedEmployeeIds, id] : draft.mutedEmployeeIds.filter((x) => x !== id) });
  const active = (emps ?? []).filter((e) => e.status !== "ARCHIVED" || draft.mutedEmployeeIds.includes(e.id));
  return (
    <Card className="min-w-0 lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">{t("notifications.title")}</CardTitle>
        <CardDescription>{t("notifications.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("notifications.kind")}
                </th>
                {data.channelNames.map((c) => (
                  <th key={c} scope="col" className="px-2 py-1 text-center font-medium">
                    {t(`notifications.channel.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.kinds.map((k) => (
                <tr key={k} className="border-t">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {t(`notifications.kinds.${k}`)}
                  </th>
                  {data.channelNames.map((c) => (
                    <td key={c} className="px-2 py-2 text-center">
                      <Switch
                        checked={draft.channels[k]?.[c] !== false}
                        onCheckedChange={(v) => setCell(k, c, v)}
                        aria-label={t("notifications.cellLabel", { kind: t(`notifications.kinds.${k}`), channel: t(`notifications.channel.${c}`) })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("notifications.mutedTitle")}</div>
          <p className="text-xs text-muted-foreground">{t("notifications.mutedHelp")}</p>
          {!active.length && <p className="text-xs text-muted-foreground">{t("notifications.noEmployees")}</p>}
          <ul className="grid gap-1 sm:grid-cols-2">
            {active.map((e) => {
              const muted = draft.mutedEmployeeIds.includes(e.id);
              return (
                <li key={e.id}>
                  <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
                    <Switch checked={muted} onCheckedChange={(v) => toggleMute(e.id, v)} />
                    <Avatar emoji={e.avatar} size="sm" />
                    <span className="flex-1 truncate">{e.name}</span>
                    {muted && <span className="text-xs text-muted-foreground">{t("notifications.muted")}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc("saving") : tc("save")}
        </Button>
      </CardContent>
    </Card>
  );
}
