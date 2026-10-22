import { desc, eq } from "drizzle-orm";
import { db, webhookDeliveries } from "@wfos/db";
import { route } from "@/lib/server/route";
import { redis } from "@/lib/server/queue";
import { loadWebhook, webhookDroppedKey } from "@/lib/server/webhooks";

/**
 * The trigger's last 50 deliveries, newest first (payload excerpts are already redacted), and how many authenticated
 * calls were refused today past the rate limit (those are counted, not stored as deliveries).
 */
export const GET = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const w = await loadWebhook(session.workspaceId, params.id);
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      taskId: webhookDeliveries.taskId,
      error: webhookDeliveries.error,
      idempotencyKey: webhookDeliveries.idempotencyKey,
      payloadExcerpt: webhookDeliveries.payloadExcerpt,
      triageReason: webhookDeliveries.triageReason,
      receivedAt: webhookDeliveries.receivedAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.triggerId, w.id))
    .orderBy(desc(webhookDeliveries.receivedAt))
    .limit(50);
  const dropped = Number(await redis().get(webhookDroppedKey(w.id)).catch(() => null)) || 0;
  return { deliveries: rows, rateLimitedToday: dropped };
});
