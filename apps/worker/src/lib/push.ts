import { and, eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { db, members, pushSubscriptions } from "@wfos/db";
import { pushEndpointAllowed, pushPayload } from "@wfos/shared/push";
import { log } from "./logger";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export type PushSender = (target: PushTarget, body: string) => Promise<{ statusCode: number }>;

function vapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || "mailto:admin@localhost" };
}

const defaultSender: PushSender = async (target, body) => {
  const v = vapid()!;
  const r = await webpush.sendNotification(target, body, { vapidDetails: v, TTL: 24 * 3600, timeout: 10_000 });
  return { statusCode: r.statusCode };
};
let sender: PushSender = defaultSender;
/** Tests replace the transport: no real push service is contacted. */
export function setPushSender(s: PushSender | null): void {
  sender = s ?? defaultSender;
}

export function pushConfigured(): boolean {
  return !!vapid();
}

/** Web Push to every subscribed device of the workspace's members. Gone subscriptions (404/410) are removed. */
export async function pushNotify(workspaceId: string, subject: string, text: string, link?: string): Promise<number> {
  if (!pushConfigured()) return 0;
  const userIds = (await db.select({ id: members.userId }).from(members).where(eq(members.workspaceId, workspaceId))).map((m) => m.id);
  if (!userIds.length) return 0;
  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds));
  const body = JSON.stringify(pushPayload(subject, text, link));
  let sent = 0;
  for (const s of subs) {
    // re-checked at send time: the policy may be stricter than when the row was stored
    if (!pushEndpointAllowed(s.endpoint)) continue;
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, s.id), eq(pushSubscriptions.userId, s.userId)));
      else log.warn({ status, err: (e as Error).message }, "web push failed");
    }
  }
  return sent;
}
