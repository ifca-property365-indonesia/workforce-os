import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { createTask, db, TaskInputError, webhookDeliveries, webhookTriggers } from "@wfos/db";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_RATE_PER_MIN } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { logger } from "@/lib/server/logger";
import { publish, q, redis } from "@/lib/server/queue";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";
import {
  errorTag,
  parseWebhookPayload,
  presentedWebhookSecret,
  readBodyCapped,
  WEBHOOK_IDEMPOTENCY_KEY_MAX,
  webhookBrief,
  webhookDroppedKey,
  webhookExcerpt,
  webhookSecretMatches,
  webhookTitle,
} from "@/lib/server/webhooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One IP may call several triggers (a relay service), but not flood or scan them: a wider per-IP window. */
const IP_RATE_PER_MIN = WEBHOOK_RATE_PER_MIN * 5;

// Responses go to external systems, not to a signed-in user: short, untranslated and generic.
const reply = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });
const NOT_FOUND = () => reply(404, { error: "Not found" });
const UNAUTHORIZED = () => reply(401, { error: "Unauthorized" });
const TOO_MANY = () => reply(429, { error: "Too many requests" }, { "retry-after": "60" });

async function countDropped(triggerId: string): Promise<void> {
  try {
    const k = webhookDroppedKey(triggerId);
    if ((await redis().incr(k)) === 1) await redis().expire(k, 2 * 86_400);
  } catch (e) {
    logger.warn({ err: errorTag(e), triggerId }, "webhook drop counter not updated");
  }
}

async function limited(key: string, max: number): Promise<boolean> {
  try {
    await rateLimit(key, max, 60);
    return false;
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return true;
    throw e;
  }
}

/**
 * Inbound webhook: an external system POSTs here with the trigger's bearer secret and a task is created for the
 * trigger's employee or team. No session. The payload is untrusted: it is fenced and escaped in the brief, and the
 * task is marked untrusted_input, so its run starts tainted (every irreversible action needs a human approval).
 *
 * Kill switch: a delivery is still accepted while it is engaged. The task waits QUEUED (the worker does not start
 * runs under the kill switch) and is resumed when the switch is released, so no external event is lost.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let trigger: typeof webhookTriggers.$inferSelect | undefined;
  let excerpt = "";
  try {
    // 1. per-IP rate limit before anything else (also bounds scanning for trigger ids)
    if (await limited(`webhook:ip:${clientIp(req)}`, IP_RATE_PER_MIN)) return TOO_MANY();

    // 2. the trigger: unknown and disabled look the same
    if (!UUID.test(id)) return NOT_FOUND();
    [trigger] = await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id));
    if (!trigger || !trigger.enabled) return NOT_FOUND();

    // 3. the secret (sha256 + timingSafeEqual on equal-length digests)
    if (!webhookSecretMatches(presentedWebhookSecret(req.headers), trigger.secretHash)) return UNAUTHORIZED();

    // from here on the caller is authenticated: refusals are logged as "rejected" deliveries for the admin
    const t = trigger;
    const reject = async (status: number, error: string, message: string, headers?: Record<string, string>) => {
      await db.insert(webhookDeliveries).values({ triggerId: t.id, workspaceId: t.workspaceId, status: "rejected", error, payloadExcerpt: excerpt });
      return reply(status, { error: message }, headers);
    };

    // 4. per-trigger rate limit, counted for authenticated calls only: a stranger who knows the URL
    //    cannot use up the real sender's budget. Refusals past the limit are counted, not logged as deliveries
    //    (a flooding sender must not be able to fill the delivery table).
    if (await limited(`webhook:trigger:${t.id}`, WEBHOOK_RATE_PER_MIN)) {
      await countDropped(t.id);
      return TOO_MANY();
    }

    // 5. the body, hard-capped while streaming
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > WEBHOOK_IDEMPOTENCY_KEY_MAX) {
      return reject(400, "idempotency_key_too_long", `Idempotency-Key is longer than ${WEBHOOK_IDEMPOTENCY_KEY_MAX} characters`);
    }
    const bytes = await readBodyCapped(req, WEBHOOK_MAX_BODY_BYTES);
    if (!bytes) return reject(413, "payload_too_large", `Payload larger than ${WEBHOOK_MAX_BODY_BYTES} bytes`);
    const payload = parseWebhookPayload(bytes, req.headers.get("content-type"));
    excerpt = webhookExcerpt(payload.text);

    // 6. delivery + task in one transaction; the unique (trigger_id, idempotency_key) index makes a concurrent
    //    retry wait for this insert and then see a conflict instead of creating a second task
    const out = await db.transaction(async (tx) => {
      const [delivery] = await tx
        .insert(webhookDeliveries)
        .values({ triggerId: t.id, workspaceId: t.workspaceId, idempotencyKey, status: "accepted", payloadExcerpt: excerpt })
        .onConflictDoNothing({ target: [webhookDeliveries.triggerId, webhookDeliveries.idempotencyKey], where: sql`${webhookDeliveries.idempotencyKey} is not null` })
        .returning({ id: webhookDeliveries.id });
      if (!delivery) return { duplicate: true as const };
      const task = await createTask(tx, {
        workspaceId: t.workspaceId,
        title: webhookTitle(t.name, delivery.id),
        brief: webhookBrief(t.briefTemplate, payload),
        assigneeId: t.assigneeId,
        teamId: t.teamId,
        source: "webhook",
        dryRun: t.dryRun,
        untrustedInput: true,
      });
      await tx.update(webhookDeliveries).set({ taskId: task.id }).where(eq(webhookDeliveries.id, delivery.id));
      await tx.update(webhookTriggers).set({ lastFiredAt: new Date() }).where(eq(webhookTriggers.id, t.id));
      return { duplicate: false as const, task };
    });

    if (out.duplicate) {
      const [first] = await db
        .select({ taskId: webhookDeliveries.taskId })
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.triggerId, t.id), eq(webhookDeliveries.idempotencyKey, idempotencyKey!)));
      // logged without the key: the key column is unique per trigger and belongs to the first delivery
      await db.insert(webhookDeliveries).values({ triggerId: t.id, workspaceId: t.workspaceId, status: "duplicate", taskId: first?.taskId ?? null, payloadExcerpt: excerpt });
      return reply(200, { status: "duplicate", taskId: first?.taskId ?? null });
    }

    // 7. like POST /api/tasks: announce and start. The task exists either way; a failed enqueue is picked up again
    //    (kill switch release, rerun), so the sender is not told to retry and create a second task.
    const task = out.task;
    try {
      await publish(t.workspaceId, { type: "task.created", taskId: task.id, title: task.title, employeeId: task.assigneeId });
      await q.task(task.id, t.workspaceId);
    } catch (e) {
      logger.error({ err: errorTag(e), taskId: task.id, triggerId: t.id }, "webhook task created but not enqueued");
    }
    return reply(202, { status: "accepted", taskId: task.id });
  } catch (e) {
    // the error code or class only: a message can embed the payload or query parameters
    const misconfigured = e instanceof TaskInputError;
    logger.error({ err: errorTag(e), triggerId: trigger?.id ?? id }, misconfigured ? "webhook trigger misconfigured" : "webhook delivery failed");
    if (trigger) {
      const error = misconfigured ? e.code : "internal_error";
      await db
        .insert(webhookDeliveries)
        .values({ triggerId: trigger.id, workspaceId: trigger.workspaceId, status: "failed", error, payloadExcerpt: excerpt })
        .catch((err: unknown) => logger.error({ err: errorTag(err), triggerId: trigger?.id }, "webhook failure not recorded"));
    }
    // the trigger's target is gone or invalid: the sender's request is fine, the trigger is not (retrying will not help
    // until an admin fixes it), so a 409 with the code rather than a 500
    if (misconfigured) return reply(409, { error: "Trigger is misconfigured", code: e.code });
    return reply(500, { error: "Internal error" });
  }
}
