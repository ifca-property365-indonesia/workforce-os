import { activeSkillAudit, startSkillAudit } from "@wfos/db";
import { todayIn } from "@wfos/shared/health";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { enqueueTask, publish, redis } from "../lib/redis";
import { checkSkillUpdates, workspacesWithMonthlyAudit } from "../hr/skill-catalog";

const TZ = process.env.APP_TIME_ZONE || "Asia/Jakarta";
/** Local hour (APP_TIME_ZONE) of the monthly audit, on the 1st. */
export const SKILL_AUDIT_HOUR = 9;
/** Local hour of the daily catalog update check. */
export const SKILL_UPDATE_HOUR = 4;
/** How often index.ts asks whether either is due (each runs once per period, claimed in Redis). */
export const SKILL_AUDIT_CHECK_MS = 10 * 60_000;

const localHour = (now: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(now));

/** On the 1st at SKILL_AUDIT_HOUR: a skill audit for every workspace that turned it on (none while one still runs). */
export async function monthlySkillAuditTick(now: Date = new Date()): Promise<number> {
  const today = todayIn(TZ, now);
  if (!today.endsWith("-01") || localHour(now) !== SKILL_AUDIT_HOUR) return 0;
  const claimed = await redis.set(`${env.namespace}:skill-audit:${today.slice(0, 7)}`, "1", "EX", 3 * 86_400, "NX");
  if (!claimed) return 0;
  let due: Awaited<ReturnType<typeof workspacesWithMonthlyAudit>>;
  try {
    due = await workspacesWithMonthlyAudit();
  } catch (e) {
    // the month is not lost: the next tick (still 09:xx) claims it again
    await redis.del(`${env.namespace}:skill-audit:${today.slice(0, 7)}`);
    throw e;
  }
  let started = 0;
  for (const w of due) {
    try {
      if (await activeSkillAudit(w.id)) continue;
      const task = await startSkillAudit({ workspaceId: w.id, hrEmployeeId: w.hrEmployeeId, trigger: "monthly" });
      if (!task) {
        log.warn({ workspaceId: w.id }, "monthly skill audit: no active HR employee");
        continue;
      }
      await publish(w.id, { type: "task.created", taskId: task.id, title: task.title, employeeId: task.assigneeId ?? undefined });
      await enqueueTask(task.id, w.id);
      started += 1;
    } catch (e) {
      log.warn({ err: e, workspaceId: w.id }, "monthly skill audit failed to start");
    }
  }
  return started;
}

/** Daily at SKILL_UPDATE_HOUR: note newer commits of catalog skills (never applied without a person). */
export async function skillUpdateTick(now: Date = new Date()): Promise<number | null> {
  if (localHour(now) !== SKILL_UPDATE_HOUR) return null;
  const claimed = await redis.set(`${env.namespace}:skill-updates:${todayIn(TZ, now)}`, "1", "EX", 2 * 86_400, "NX");
  if (!claimed) return null;
  const found = await checkSkillUpdates(now, 40);
  if (found) log.info({ found }, "catalog skill updates found");
  return found;
}
