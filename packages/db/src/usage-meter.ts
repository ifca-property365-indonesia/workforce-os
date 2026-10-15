import { and, eq, gte, isNotNull, lt, min, sql, sum } from "drizzle-orm";
import { CREDIT_USD } from "@wfos/shared";
import {
  addCalibrationPoint,
  calibrationPoint,
  estimateWindow,
  fiveHourWindow,
  liveReset,
  parseUsageBudget,
  parseUsageCalibration,
  resolveSchedule,
  sevenDayWindow,
  WINDOW_MS,
  type MeterWindow,
  type MeterWindowType,
  type ResetSchedule,
  type UsageBudget,
  type WindowMeter,
} from "@wfos/shared/usage-meter";
import { getDb } from "./index";
import { claudeLimits, steps, workspaces } from "./schema";

type Source = "workspace" | "instance";

/**
 * workforce-os model spend of a workspace in [from, to), API-equivalent USD. Only steps with a model count (run turns,
 * subagent turns, lead reviews, routing): tool credits are not Claude usage. Steps do not record which credential ran
 * them, so this is the workspace's spend whatever credential source.
 */
export async function llmSpendUsd(workspaceId: string, from: Date, to: Date = new Date()): Promise<number> {
  const [r] = await getDb()
    .select({ s: sum(steps.credits) })
    .from(steps)
    .where(and(eq(steps.workspaceId, workspaceId), gte(steps.createdAt, from), lt(steps.createdAt, to), isNotNull(steps.model)));
  return Number(r?.s ?? 0) * CREDIT_USD;
}

/** The first model step of a workspace at or after `from` (opens a 5-hour window), or null. */
export async function firstLlmStepAt(workspaceId: string, from: Date): Promise<Date | null> {
  const [r] = await getDb()
    .select({ t: min(steps.createdAt) })
    .from(steps)
    .where(and(eq(steps.workspaceId, workspaceId), gte(steps.createdAt, from), isNotNull(steps.model), sql`${steps.credits} > 0`));
  return r?.t ? new Date(r.t as unknown as string) : null;
}

async function limitRows(workspaceId: string) {
  return getDb().select().from(claudeLimits).where(eq(claudeLimits.workspaceId, workspaceId));
}

/** The weekly schedule of a workspace: the owner's, else Claude's last weekly reset, else Sunday 00:00. */
export function scheduleFor(budget: UsageBudget, rows: { credentialSource: string; rateLimitType: string; resetsAt: Date | null }[], source: Source | null, timezone: string): ResetSchedule {
  const weekly = rows.filter((r) => r.rateLimitType === "seven_day" && r.resetsAt);
  const own = weekly.find((r) => r.credentialSource === source) ?? weekly.sort((a, b) => b.resetsAt!.getTime() - a.resetsAt!.getTime())[0];
  return resolveSchedule(budget, own?.resetsAt ?? null, timezone);
}

export interface UsageMeter {
  /** estimates cover workforce-os's own runs only; other use of the same Claude account is not counted */
  scope: "workforce_os_only";
  budget: UsageBudget;
  schedule: ResetSchedule;
  windows: WindowMeter[];
}

/** The estimated usage meter (5-hour and weekly) of a workspace's credential. Display only. */
export async function usageMeter(workspaceId: string, source: Source, now: Date = new Date()): Promise<UsageMeter> {
  const [ws] = await getDb().select({ settings: workspaces.settings, timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const budget = parseUsageBudget(ws?.settings);
  const calibration = parseUsageCalibration(ws?.settings)[source] ?? {};
  const rows = await limitRows(workspaceId);
  const schedule = scheduleFor(budget, rows, source, ws?.timezone ?? "Asia/Jakarta");
  const row = (type: MeterWindowType) => rows.find((r) => r.credentialSource === source && r.rateLimitType === type) ?? null;

  const out: WindowMeter[] = [];
  for (const type of ["five_hour", "seven_day"] as const) {
    const r = row(type);
    const window: MeterWindow | null =
      type === "seven_day" ? sevenDayWindow(now, schedule, r?.resetsAt ?? null) : await fiveHourWindow(now, r?.resetsAt ?? null, (from) => firstLlmStepAt(workspaceId, from));
    const spendUsd = window ? await llmSpendUsd(workspaceId, window.start, now) : 0;
    out.push(
      estimateWindow({
        type,
        now,
        window,
        scheduleSource: schedule.source,
        spendUsd,
        points: calibration[type],
        budgetUsd: type === "seven_day" ? budget.weeklyUsd : budget.fiveHourUsd,
        row: r ? { utilization: r.utilization, status: r.status, resetsAt: r.resetsAt, updatedAt: r.updatedAt } : null,
      }),
    );
  }
  return { scope: "workforce_os_only", budget, schedule, windows: out };
}

/**
 * Record a calibration point when Claude reports a real utilization for a 5-hour or weekly window: our spend in that
 * window up to now against the reported percent. Needs the window's reset time (to know where the window starts).
 * Never throws; returns whether a point was stored.
 */
export async function recordUsageCalibration(
  workspaceId: string,
  source: Source,
  type: string,
  utilization: number | null,
  resetsAt: Date | null,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (type !== "five_hour" && type !== "seven_day") return false;
    const end = liveReset(type, resetsAt, now);
    if (!end || utilization === null) return false;
    const spend = await llmSpendUsd(workspaceId, new Date(end.getTime() - WINDOW_MS[type]), now);
    const point = calibrationPoint(spend, utilization, now, end);
    if (!point) return false;
    const db = getDb();
    const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const all = parseUsageCalibration(ws?.settings);
    const next = addCalibrationPoint(all[source]?.[type], point, now);
    if (!next) return false;
    const updated = { ...all, [source]: { ...(all[source] ?? {}), [type]: next } };
    // only this key is replaced: the other settings (budget, company, email policy) are merged in SQL
    await db
      .update(workspaces)
      .set({ settings: sql`coalesce(${workspaces.settings}, '{}'::jsonb) || jsonb_build_object('usageCalibration', ${JSON.stringify(updated)}::jsonb)` })
      .where(eq(workspaces.id, workspaceId));
    return true;
  } catch {
    return false;
  }
}
