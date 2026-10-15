import { eq, sql } from "drizzle-orm";
import { audit, claudeCredentialStatus, claudeLimits, db, scheduleFor, workspaces } from "@wfos/db";
import { parseUsageBudget, usageBudgetSchema } from "@wfos/shared/usage-meter";
import { patchBody, route } from "@/lib/server/route";

async function current(workspaceId: string) {
  const [ws] = await db.select({ settings: workspaces.settings, timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const budget = parseUsageBudget(ws?.settings);
  const rows = await db.select().from(claudeLimits).where(eq(claudeLimits.workspaceId, workspaceId));
  const cred = await claudeCredentialStatus(workspaceId);
  // the schedule in effect: the owner's, else derived from Claude's last weekly reset, else Sunday 00:00
  const schedule = scheduleFor(budget, rows, cred.effective?.source ?? null, ws?.timezone ?? "Asia/Jakarta");
  return { budget, schedule, workspaceTimezone: ws?.timezone ?? "Asia/Jakarta" };
}

/**
 * The estimated-usage budget (workspaces.settings.usageBudget): weekly / 5-hour USD and the weekly reset schedule.
 * Display only: it never pauses runs or sends warnings.
 */
export const GET = route("VIEWER", async ({ session }) => current(session.workspaceId));

export const PUT = route("ADMIN", async ({ session, req }) => {
  // only the keys sent: a missing key keeps its stored value; null clears it (automatic schedule, no budget)
  const input = await patchBody(req, usageBudgetSchema);
  const before = (await current(session.workspaceId)).budget;
  const budget = usageBudgetSchema.parse({ ...before, ...input });
  // merge in SQL: the other settings keys (calibration points, company profile, …) are never overwritten
  await db
    .update(workspaces)
    .set({ settings: sql`coalesce(${workspaces.settings}, '{}'::jsonb) || jsonb_build_object('usageBudget', ${JSON.stringify(budget)}::jsonb)` })
    .where(eq(workspaces.id, session.workspaceId));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "settings.usage_budget_changed",
    targetType: "workspace",
    targetId: session.workspaceId,
    details: { before, after: budget },
  });
  return current(session.workspaceId);
});
