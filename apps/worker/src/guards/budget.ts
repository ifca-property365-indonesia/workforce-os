import { db, employees, steps, workspaces } from "@wfos/db";
import { and, eq, gte, sum } from "drizzle-orm";
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
