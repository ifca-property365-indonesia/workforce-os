import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, webhookTriggers } from "@wfos/db";
import { patchBody, route } from "@/lib/server/route";
import { assertWebhookTarget, loadWebhook, publicWebhook } from "@/lib/server/webhooks";

type P = { id: string };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  dryRun: z.boolean(),
  briefTemplate: z.string().max(8000),
  triage: z.boolean(),
  triageRules: z.string().max(4000),
  assigneeId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
}).partial();

/**
 * Change a trigger. The target is one employee or one team: sending an assigneeId alone moves the trigger to that
 * employee (and clears the team), a teamId alone to that team.
 */
export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const before = await loadWebhook(session.workspaceId, params.id);
  const input = await patchBody(req, patchSchema);
  const set: Partial<typeof webhookTriggers.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.dryRun !== undefined) set.dryRun = input.dryRun;
  if (input.briefTemplate !== undefined) set.briefTemplate = input.briefTemplate;
  if (input.triage !== undefined) set.triage = input.triage;
  if (input.triageRules !== undefined) set.triageRules = input.triageRules;
  if (input.assigneeId !== undefined || input.teamId !== undefined) {
    let assigneeId = input.assigneeId !== undefined ? input.assigneeId : before.assigneeId;
    let teamId = input.teamId !== undefined ? input.teamId : before.teamId;
    if (input.assigneeId && input.teamId === undefined) teamId = null;
    if (input.teamId && input.assigneeId === undefined) assigneeId = null;
    await assertWebhookTarget(session.workspaceId, assigneeId, teamId);
    set.assigneeId = assigneeId;
    set.teamId = teamId;
  }
  if (!Object.keys(set).length) return { webhook: publicWebhook(before) };
  const [w] = await db.update(webhookTriggers).set(set).where(eq(webhookTriggers.id, before.id)).returning();
  const details: Record<string, unknown> = { fields: Object.keys(set) };
  for (const k of ["name", "enabled", "dryRun", "triage", "assigneeId", "teamId"] as const) if (k in set) details[k] = set[k];
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "webhook.updated", targetType: "webhook", targetId: w!.id, details });
  return { webhook: publicWebhook(w!) };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  const w = await loadWebhook(session.workspaceId, params.id);
  await db.delete(webhookTriggers).where(eq(webhookTriggers.id, w.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "webhook.deleted", targetType: "webhook", targetId: w.id, details: { name: w.name } });
  return { ok: true };
});
