import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, recurringBillings } from "@wfos/db";
import { recurringBillingInputSchema } from "@wfos/shared";
import { body, notFound, route } from "@/lib/server/route";
import { assertBillingRefs, billingNextRun, workspaceTimeZone } from "@/lib/server/clients";

type P = { id: string };

/**
 * Fields not sent keep their value (the client never changes). A new schedule, or switching a paused billing back
 * on, moves the next run; changing monthly ↔ yearly also forgets the last period invoiced (its format changes).
 */
export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const raw = await body(req, z.record(z.string(), z.unknown()));
  const [row] = await db.select().from(recurringBillings).where(and(eq(recurringBillings.id, params.id), eq(recurringBillings.workspaceId, session.workspaceId)));
  if (!row) notFound();
  const { id: _id, workspaceId: _ws, lastPeriod, nextRunAt, createdAt: _c, updatedAt: _u, ...stored } = row;
  const next = recurringBillingInputSchema.parse({ ...stored, ...raw, clientId: row.clientId });
  await assertBillingRefs(session.workspaceId, next);
  const startMonth = next.period === "yearly" ? next.startMonth : null;
  const rescheduled = next.period !== row.period || next.dayOfMonth !== row.dayOfMonth || startMonth !== row.startMonth || (next.active && !row.active) || (next.active && !nextRunAt);
  const [r] = await db
    .update(recurringBillings)
    .set({
      ...next,
      startMonth,
      lastPeriod: next.period !== row.period ? null : lastPeriod,
      nextRunAt: rescheduled ? billingNextRun({ ...next, startMonth }, await workspaceTimeZone(session.workspaceId)) : nextRunAt,
    })
    .where(eq(recurringBillings.id, row.id))
    .returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "recurring_billing.updated",
    targetType: "client",
    targetId: row.clientId,
    details: { id: row.id, fields: Object.keys(raw).filter((k) => k !== "clientId") },
  });
  return { recurring: r };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  const [r] = await db.delete(recurringBillings).where(and(eq(recurringBillings.id, params.id), eq(recurringBillings.workspaceId, session.workspaceId))).returning();
  if (!r) notFound();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "recurring_billing.deleted", targetType: "client", targetId: r.clientId, details: { id: r.id, description: r.description } });
  return { ok: true };
});
