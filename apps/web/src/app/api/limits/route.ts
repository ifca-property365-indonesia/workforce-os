import { and, eq, gte, sum } from "drizzle-orm";
import { claudeCredentialStatus, claudeLimits, db, steps, usageMeter, workspaces } from "@wfos/db";
import { CREDIT_USD } from "@wfos/shared";
import { displayWindow, MODEL_WINDOW_PREFIX, WINDOW_ORDER } from "@wfos/shared/limits";
import { route } from "@/lib/server/route";

/**
 * Subscription limit meter. Windows are shown only when the workspace runs on a Claude subscription (oauth);
 * API-key workspaces keep the credit/USD meter. USD-equivalent cost is always returned as a secondary number.
 * `meter`: the estimated 5-hour and weekly usage (workforce-os runs only; display only, see @wfos/shared/usage-meter).
 */
export const GET = route("VIEWER", async ({ session }) => {
  const cred = await claudeCredentialStatus(session.workspaceId);
  const subscription = cred.effective?.type === "oauth";
  const rows = subscription
    ? await db.select().from(claudeLimits).where(and(eq(claudeLimits.workspaceId, session.workspaceId), eq(claudeLimits.credentialSource, cred.effective!.source)))
    : [];
  const now = new Date();
  // a window whose reset time passed shows as reset (its stored numbers are from the previous window); per-model
  // weekly windows (seven_day_model:<name>) after the known ones
  const order = (t: string) => WINDOW_ORDER.indexOf(t) + 1 || (t.startsWith(MODEL_WINDOW_PREFIX) ? 50 : 99);
  const windows = rows
    .map((r) => displayWindow({ type: r.rateLimitType, status: r.status as string, utilization: r.utilization, resetsAt: r.resetsAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() }, now))
    .sort((a, b) => order(a.type) - order(b.type) || a.type.localeCompare(b.type));
  const syncedAt = rows.length ? new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))).toISOString() : null;
  const [ws] = await db.select({ until: workspaces.quotaPausedUntil, reason: workspaces.quotaPauseReason }).from(workspaces).where(eq(workspaces.id, session.workspaceId));
  const month = new Date();
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  const [spend] = await db.select({ s: sum(steps.credits) }).from(steps).where(and(eq(steps.workspaceId, session.workspaceId), gte(steps.createdAt, month)));
  const paused = ws?.until && ws.until.getTime() > Date.now();
  const meter = subscription ? await usageMeter(session.workspaceId, cred.effective!.source, now) : null;
  return {
    subscription,
    source: cred.effective?.source ?? null,
    windows,
    meter,
    syncedAt,
    paused: paused ? { until: ws!.until!.toISOString(), reason: ws!.reason } : null,
    usdThisMonth: Number(spend?.s ?? 0) * CREDIT_USD,
  };
});
