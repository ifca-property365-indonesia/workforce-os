import "server-only";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, sum } from "drizzle-orm";
import { appDocuments, appEnvironments, appModules, appModuleTasks, appReleases, apps, appTests, db, steps, tasks } from "@wfos/db";

/**
 * The home page's "needs attention": apps whose preview or LIVE is not well (failed, unhealthy, down, a failed
 * release in the last week, a certificate about to expire), module work waiting, test findings nobody handled, and
 * this week's spend against the week before. Facts only; each line links to where it is fixed.
 */
export type AppProblem = "failed" | "unhealthy" | "down" | "maintenance" | "stopped" | "release_failed" | "cert_expiring";
export interface Attention {
  apps: { id: string; name: string; problems: { env: "preview" | "live"; problem: AppProblem }[] }[];
  modules: { prdDrafts: number; waiting: number; building: number };
  findings: number;
  spend: { last7: number; prev7: number };
}

const DAY = 86_400_000;

export async function attention(workspaceId: string, now = new Date()): Promise<Attention> {
  const envs = await db
    .select({ id: appEnvironments.id, appId: apps.id, name: apps.name, kind: appEnvironments.kind, status: appEnvironments.status, healthy: appEnvironments.healthy, uptime: appEnvironments.uptimeStatus, maintenance: appEnvironments.maintenance, cert: appEnvironments.certExpiresAt })
    .from(appEnvironments)
    .innerJoin(apps, eq(apps.id, appEnvironments.appId))
    .where(eq(appEnvironments.workspaceId, workspaceId));
  // the newest release of each environment, when it failed in the last week (a later good release clears it)
  const latest = envs.length
    ? await db
        .selectDistinctOn([appReleases.environmentId], { environmentId: appReleases.environmentId, status: appReleases.status, at: appReleases.createdAt })
        .from(appReleases)
        .where(inArray(appReleases.environmentId, envs.map((e) => e.id)))
        .orderBy(appReleases.environmentId, desc(appReleases.createdAt))
    : [];
  const failedRelease = new Set(latest.filter((r) => r.status === "failed" && r.at > new Date(now.getTime() - 7 * DAY)).map((r) => r.environmentId));
  const byApp = new Map<string, Attention["apps"][number]>();
  for (const e of envs) {
    const problems: AppProblem[] = [];
    if (e.status === "failed") problems.push("failed");
    else if (e.status === "running" && e.healthy === false) problems.push("unhealthy");
    if (e.kind === "live") {
      if (e.status === "stopped") problems.push("stopped");
      if (e.status === "running" && e.uptime === "down") problems.push("down");
      if (e.maintenance) problems.push("maintenance");
      if (e.cert && e.cert < new Date(now.getTime() + 14 * DAY)) problems.push("cert_expiring");
    }
    if (failedRelease.has(e.id)) problems.push("release_failed");
    if (!problems.length) continue;
    const a = byApp.get(e.appId) ?? { id: e.appId, name: e.name, problems: [] };
    a.problems.push(...problems.map((problem) => ({ env: e.kind, problem })));
    byApp.set(e.appId, a);
  }

  const [drafts] = await db
    .select({ n: count() })
    .from(appDocuments)
    .where(and(eq(appDocuments.workspaceId, workspaceId), isNotNull(appDocuments.moduleId), eq(appDocuments.status, "draft")));
  const [waiting] = await db.select({ n: count() }).from(appModules).where(and(eq(appModules.workspaceId, workspaceId), isNotNull(appModules.pendingWork), isNull(appModules.hold)));
  const [building] = await db
    .select({ n: count() })
    .from(appModuleTasks)
    .innerJoin(tasks, eq(tasks.id, appModuleTasks.taskId))
    .where(and(eq(appModuleTasks.workspaceId, workspaceId), inArray(appModuleTasks.role, ["build", "change"]), inArray(tasks.status, ["QUEUED", "RUNNING", "AWAITING_APPROVAL"])));
  const [findings] = await db.select({ n: count() }).from(appTests).where(and(eq(appTests.workspaceId, workspaceId), eq(appTests.status, "findings"), isNull(appTests.handledAt)));
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  const [w1] = await db.select({ c: sum(steps.credits) }).from(steps).where(and(eq(steps.workspaceId, workspaceId), gt(steps.createdAt, since(7))));
  const [w2] = await db.select({ c: sum(steps.credits) }).from(steps).where(and(eq(steps.workspaceId, workspaceId), gt(steps.createdAt, since(14)), lt(steps.createdAt, since(7))));
  return {
    apps: [...byApp.values()].sort((a, b) => a.name.localeCompare(b.name)),
    modules: { prdDrafts: Number(drafts?.n ?? 0), waiting: Number(waiting?.n ?? 0), building: Number(building?.n ?? 0) },
    findings: Number(findings?.n ?? 0),
    spend: { last7: Number(w1?.c ?? 0), prev7: Number(w2?.c ?? 0) },
  };
}
