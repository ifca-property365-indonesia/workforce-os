import { eq } from "drizzle-orm";
import { audit, db, webhookTriggers } from "@wfos/db";
import { route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";
import { generateWebhookSecret, hashWebhookSecret, loadWebhook, webhookUrl } from "@/lib/server/webhooks";

/** A new secret (shown once); the old one stops working at once. Owner, with a fresh password + 2FA confirmation. */
export const POST = route<{ id: string }>("OWNER", async ({ session, params }) => {
  const w = await loadWebhook(session.workspaceId, params.id);
  await requireStepUp(session);
  const secret = generateWebhookSecret();
  await db.update(webhookTriggers).set({ secretHash: hashWebhookSecret(secret) }).where(eq(webhookTriggers.id, w.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "webhook.secret_rotated", targetType: "webhook", targetId: w.id, details: { name: w.name } });
  return { secret, url: webhookUrl(w.id) };
});
