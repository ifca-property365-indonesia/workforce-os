"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Account → push notifications on this device (per browser, not per account). */
export function PushCard() {
  const t = useTranslations("account");
  const { data } = useQuery({ queryKey: ["push-config"], queryFn: () => api.get<{ enabled: boolean; publicKey: string | null }>("/api/me/push") });
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!supported()) return setSub(null);
    void navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription() ?? null).then(setSub);
  }, []);
  if (!data?.enabled || !data.publicKey) return null;

  const enable = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") return toast.error(t("push.denied"));
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.publicKey!) });
      await api.post("/api/me/push", s.toJSON());
      setSub(s);
      toast.success(t("push.enabled"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    if (!sub) return;
    setBusy(true);
    try {
      await api.del("/api/me/push", { endpoint: sub.endpoint });
      await sub.unsubscribe();
      setSub(null);
      toast.success(t("push.disabled"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("push.title")}</CardTitle>
        <CardDescription>{t("push.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!supported() ? (
          <p className="text-muted-foreground">{t("push.unsupported")}</p>
        ) : sub ? (
          <>
            <p>{t("push.on")}</p>
            <Button variant="outline" disabled={busy} onClick={() => void disable()}>
              {t("push.turnOff")}
            </Button>
          </>
        ) : (
          <Button disabled={busy || sub === undefined} onClick={() => void enable()}>
            {t("push.turnOn")}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{t("push.iosHint")}</p>
      </CardContent>
    </Card>
  );
}
