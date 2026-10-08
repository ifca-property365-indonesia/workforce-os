import { and, eq, gte, sum } from "drizzle-orm";
import { claudeCredentialStatus, claudeLimits, db, steps, workspaces } from "@wfos/db";
import { CREDIT_USD } from "@wfos/shared";
import { WINDOW_ORDER } from "@wfos/shared/limits";
import { route } from "@/lib/server/route";

/**
 * Subscription limit meter. Windows are shown only when the workspace runs on a Claude subscription (oauth);
 * API-key workspaces keep the credit/USD meter. USD-equivalent cost is always returned as a secondary number.
 */
export const GET = route("VIEWER", async ({ session }) => {
  const cred = await claudeCredentialStatus(session.workspaceId);
  const subscription = cred.effective?.type === "oauth";
  const rows = subscription
    ? await db.select().from(claudeLimits).where(and(eq(claudeLimits.workspaceId, session.workspaceId), eq(claudeLimits.credentialSource, cred.effective!.source)))
    : [];
  const windows = rows
    .map((r) => ({ type: r.rateLimitType, status: r.status, utilization: r.utilization, resetsAt: r.resetsAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() }))
    .sort((a, b) => (WINDOW_ORDER.indexOf(a.type) + 1 || 99) - (WINDOW_ORDER.indexOf(b.type) + 1 || 99));
  const [ws] = await db.select({ until: workspaces.quotaPausedUntil, reason: workspaces.quotaPauseReason }).from(workspaces).where(eq(workspaces.id, session.workspaceId));
  const month = new Date();
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  const [spend] = await db.select({ s: sum(steps.credits) }).from(steps).where(and(eq(steps.workspaceId, session.workspaceId), gte(steps.createdAt, month)));
  const paused = ws?.until && ws.until.getTime() > Date.now();
  return {
    subscription,
    source: cred.effective?.source ?? null,
    windows,
    paused: paused ? { until: ws!.until!.toISOString(), reason: ws!.reason } : null,
    usdThisMonth: Number(spend?.s ?? 0) * CREDIT_USD,
  };
});
