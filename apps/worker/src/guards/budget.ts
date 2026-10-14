import { db, employees, steps, teamMembers, workspaces, type DivisionRow } from "@wfos/db";
import { and, eq, gte, inArray, or, sum } from "drizzle-orm";
import { publish } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { audit } from "@wfos/db";

export function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
export function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function employeeSpendToday(employeeId: string): Promise<number> {
  const [r] = await db
    .select({ s: sum(steps.credits) })
    .from(steps)
    .where(and(eq(steps.employeeId, employeeId), gte(steps.createdAt, startOfUtcDay())));
  return Number(r?.s ?? 0);
}

export async function workspaceSpendThisMonth(workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ s: sum(steps.credits) })
    .from(steps)
    .where(and(eq(steps.workspaceId, workspaceId), gte(steps.createdAt, startOfUtcMonth())));
  return Number(r?.s ?? 0);
}

export interface BudgetState {
  ok: boolean;
  reason?: string;
  /** credits still available for this employee today, bounded by the workspace monthly cap */
  remaining: number;
}

export async function checkBudget(workspaceId: string, employeeId: string): Promise<BudgetState> {
  const [[emp], [ws]] = await Promise.all([
    db.select().from(employees).where(eq(employees.id, employeeId)),
    db.select().from(workspaces).where(eq(workspaces.id, workspaceId)),
  ]);
  if (!emp || !ws) return { ok: false, reason: "employee or workspace missing", remaining: 0 };
  const [daySpend, monthSpend] = await Promise.all([employeeSpendToday(employeeId), workspaceSpendThisMonth(workspaceId)]);
  const dayLeft = emp.dailyBudget - daySpend;
  const monthLeft = ws.monthlyBudget - monthSpend;
  if (dayLeft <= 0) return { ok: false, reason: `Daily budget reached (${daySpend.toFixed(2)} / ${emp.dailyBudget} credits)`, remaining: 0 };
  if (monthLeft <= 0) return { ok: false, reason: `Workspace monthly budget reached (${monthSpend.toFixed(2)} / ${ws.monthlyBudget} credits)`, remaining: 0 };
  return { ok: true, remaining: Math.min(dayLeft, monthLeft) };
}

/** Hitting a cap pauses the employee; it never silently continues. */
export async function pauseForBudget(workspaceId: string, employeeId: string, reason: string, taskId?: string | null): Promise<void> {
  await db.update(employees).set({ status: "PAUSED_BUDGET" }).where(eq(employees.id, employeeId));
  await recordStep({ workspaceId, taskId, employeeId, kind: "budget", name: "budget_cap", status: "blocked", output: { reason } });
  await audit({ workspaceId, actorLabel: "system", action: "employee.paused_budget", targetType: "employee", targetId: employeeId, details: { reason } });
  await publish(workspaceId, { type: "employee.updated", employeeId, status: "PAUSED_BUDGET" });
}

/**
 * Credits the division's members spent today (UTC day, like the employee budget): every step run by a member, or acted
 * by a member as a subagent in the code lead's run. A step is counted once even when both are members.
 */
export async function divisionSpendToday(teamId: string): Promise<number> {
  const members = (await db.select({ id: teamMembers.employeeId }).from(teamMembers).where(eq(teamMembers.teamId, teamId))).map((r) => r.id);
  if (!members.length) return 0;
  const [r] = await db
    .select({ s: sum(steps.credits) })
    .from(steps)
    .where(and(or(inArray(steps.employeeId, members), inArray(steps.actorEmployeeId, members)), gte(steps.createdAt, startOfUtcDay())));
  return Number(r?.s ?? 0);
}

export interface DivisionBudgetState {
  ok: boolean;
  reason?: string;
  /** credits the division may still spend today; Infinity without a division budget */
  remaining: number;
}

/** A division with a daily budget holds its runs once its members spent it (null budget = only the employees' own caps). */
export async function checkDivisionBudget(division: Pick<DivisionRow, "id" | "dailyBudget">): Promise<DivisionBudgetState> {
  if (division.dailyBudget == null) return { ok: true, remaining: Number.POSITIVE_INFINITY };
  const spent = await divisionSpendToday(division.id);
  const left = division.dailyBudget - spent;
  if (left <= 0) return { ok: false, reason: `Division daily budget reached (${spent.toFixed(2)} / ${division.dailyBudget} credits)`, remaining: 0 };
  return { ok: true, remaining: left };
}

/** When a held division run is tried again: shortly after the next UTC midnight (the budget day). */
export function msUntilNextBudgetDay(now = new Date()): number {
  return startOfUtcDay(now).getTime() + 86_400_000 - now.getTime() + 60_000;
}
