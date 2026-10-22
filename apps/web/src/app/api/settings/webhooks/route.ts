import { asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employees, teams, webhookDeliveries, webhookTriggers } from "@wfos/db";
import type { WebhookDeliveryStatus } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { assertWebhookTarget, generateWebhookSecret, hashWebhookSecret, webhookUrl } from "@/lib/server/webhooks";

/** Inbound webhook triggers of the workspace. Never returns a secret or its hash. */
export const GET = route("ADMIN", async ({ session }) => {
  const ws = session.workspaceId;
  const [rows, counts, last] = await Promise.all([
    db
      .select({
        id: webhookTriggers.id,
        name: webhookTriggers.name,
        assigneeId: webhookTriggers.assigneeId,
        assigneeName: employees.name,
        teamId: webhookTriggers.teamId,
        teamName: teams.name,
        briefTemplate: webhookTriggers.briefTemplate,
        dryRun: webhookTriggers.dryRun,
        triage: webhookTriggers.triage,
        triageRules: webhookTriggers.triageRules,
        enabled: webhookTriggers.enabled,
        lastFiredAt: webhookTriggers.lastFiredAt,
        createdAt: webhookTriggers.createdAt,
      })
      .from(webhookTriggers)
      .leftJoin(employees, eq(employees.id, webhookTriggers.assigneeId))
      .leftJoin(teams, eq(teams.id, webhookTriggers.teamId))
      .where(eq(webhookTriggers.workspaceId, ws))
      .orderBy(asc(webhookTriggers.createdAt)),
    db
      .select({ triggerId: webhookDeliveries.triggerId, status: webhookDeliveries.status, n: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, ws))
      .groupBy(webhookDeliveries.triggerId, webhookDeliveries.status),
    db
      .selectDistinctOn([webhookDeliveries.triggerId], { triggerId: webhookDeliveries.triggerId, status: webhookDeliveries.status, receivedAt: webhookDeliveries.receivedAt })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, ws))
      .orderBy(webhookDeliveries.triggerId, desc(webhookDeliveries.receivedAt)),
  ]);
  return {
    webhooks: rows.map((r) => {
      const c: Record<WebhookDeliveryStatus, number> = { accepted: 0, duplicate: 0, rejected: 0, failed: 0, triaging: 0, dropped: 0, noted: 0, escalated: 0 };
      for (const x of counts) if (x.triggerId === r.id) c[x.status] = Number(x.n);
      const l = last.find((x) => x.triggerId === r.id);
      return { ...r, url: webhookUrl(r.id), counts: c, lastDelivery: l ? { status: l.status, receivedAt: l.receivedAt } : null };
    }),
  };
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  assigneeId: z.uuid().nullish(),
  teamId: z.uuid().nullish(),
  briefTemplate: z.string().max(8000).default(""),
  dryRun: z.boolean().default(false),
  triage: z.boolean().default(false),
  triageRules: z.string().max(4000).default(""),
});

/** Create a trigger. The secret is returned once, here; only its sha256 is stored. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, createSchema);
  await assertWebhookTarget(session.workspaceId, input.assigneeId, input.teamId);
  const secret = generateWebhookSecret();
  const [w] = await db
    .insert(webhookTriggers)
    .values({
      workspaceId: session.workspaceId,
      name: input.name,
      secretHash: hashWebhookSecret(secret),
      assigneeId: input.assigneeId ?? null,
      teamId: input.teamId ?? null,
      briefTemplate: input.briefTemplate,
      dryRun: input.dryRun,
      triage: input.triage,
      triageRules: input.triageRules,
      createdBy: session.userId,
    })
    .returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "webhook.created",
    targetType: "webhook",
    targetId: w!.id,
    details: { name: w!.name, assigneeId: w!.assigneeId, teamId: w!.teamId, dryRun: w!.dryRun },
  });
  return {
    webhook: { id: w!.id, name: w!.name, assigneeId: w!.assigneeId, teamId: w!.teamId, briefTemplate: w!.briefTemplate, dryRun: w!.dryRun, enabled: w!.enabled, url: webhookUrl(w!.id) },
    secret,
    url: webhookUrl(w!.id),
  };
});
