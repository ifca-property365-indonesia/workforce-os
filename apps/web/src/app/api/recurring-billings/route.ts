import { and, asc, eq } from "drizzle-orm";
import { audit, db, recurringBillings } from "@wfos/db";
import { recurringBillingInputSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { assertBillingRefs, billingNextRun, clientIdParam, workspaceTimeZone } from "@/lib/server/clients";

export const GET = route("VIEWER", async ({ session, req }) => {
  const clientId = clientIdParam(req.nextUrl.searchParams);
  const rows = await db
    .select()
    .from(recurringBillings)
    .where(and(eq(recurringBillings.workspaceId, session.workspaceId), clientId ? eq(recurringBillings.clientId, clientId) : undefined))
    .orderBy(asc(recurringBillings.createdAt));
  return { recurring: rows };
});

export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, recurringBillingInputSchema);
  await assertBillingRefs(session.workspaceId, input);
  const startMonth = input.period === "yearly" ? input.startMonth : null;
  const nextRunAt = billingNextRun({ ...input, startMonth }, await workspaceTimeZone(session.workspaceId));
  const [r] = await db
    .insert(recurringBillings)
    .values({ ...input, startMonth, nextRunAt, workspaceId: session.workspaceId })
    .returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "recurring_billing.created",
    targetType: "client",
    targetId: r!.clientId,
    details: { id: r!.id, description: r!.description, amount: r!.amount, period: r!.period },
  });
  return { recurring: r };
});
