import { and, asc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, pushSubscriptions } from "@wfos/db";
import { pushEndpointAllowed } from "@wfos/shared/push";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { rateLimit } from "@/lib/server/ratelimit";

const MAX_DEVICES = 10;
const subscriptionSchema = z.object({
  endpoint: z.string().max(1000),
  keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
});

/** Web Push for this browser: the VAPID public key (never the private key) and whether push is set up here. */
export const GET = route("VIEWER", async () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || null;
  return { enabled: !!(publicKey && process.env.VAPID_PRIVATE_KEY), publicKey };
});

export const POST = route("VIEWER", async ({ session, req }) => {
  if (!process.env.VAPID_PUBLIC_KEY) throw new HttpError(409, "Push notifications are not configured on this server", { code: "push_not_configured" });
  await rateLimit(`push-sub:${session.userId}`, 20, 3600);
  const input = await body(req, subscriptionSchema);
  // only the browsers' push services: the worker posts to this URL
  if (!pushEndpointAllowed(input.endpoint)) throw new HttpError(400, "This push endpoint is not allowed", { code: "push_endpoint_not_allowed" });
  const ua = req.headers.get("user-agent")?.slice(0, 200) ?? null;
  // an endpoint belongs to one browser profile: a new sign-in on the same browser takes it over
  await db
    .insert(pushSubscriptions)
    .values({ userId: session.userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: ua })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: session.userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: ua } });
  const mine = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, session.userId)).orderBy(asc(pushSubscriptions.createdAt));
  if (mine.length > MAX_DEVICES) {
    const keep = mine.slice(-MAX_DEVICES).map((m) => m.id);
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, session.userId), notInArray(pushSubscriptions.id, keep)));
  }
  return { ok: true };
});

export const DELETE = route("VIEWER", async ({ session, req }) => {
  const { endpoint } = await body(req, z.object({ endpoint: z.string().max(1000) }));
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, session.userId), eq(pushSubscriptions.endpoint, endpoint)));
  return { ok: true };
});
