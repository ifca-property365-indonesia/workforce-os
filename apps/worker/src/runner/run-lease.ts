import { eq } from "drizzle-orm";
import { conversations, db, employeeDivision, tasks, teams } from "@wfos/db";
import type { RunJob } from "@wfos/shared";
import {
  acquireDivisionLease,
  acquireEmployeeLease,
  refreshDivisionLease,
  refreshEmployeeLease,
  releaseDivisionLease,
  releaseEmployeeLease,
} from "../guards/lease";
import { log } from "../lib/logger";

/** How often a running job renews its leases (well inside LEASE_TTL_MS, 30 min). */
export const LEASE_REFRESH_MS = 5 * 60 * 1000;

/** The employee a run job runs as: the assignee, or the head (team lead) for a division-level task or team chat. */
export async function employeeForRun(data: RunJob): Promise<string | null> {
  if (data.kind === "task") {
    const [t] = await db.select({ assigneeId: tasks.assigneeId, teamId: tasks.teamId, parentTaskId: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, data.taskId));
    if (!t) return null;
    if (t.teamId && !t.parentTaskId) {
      const [team] = await db.select({ leadId: teams.leadId }).from(teams).where(eq(teams.id, t.teamId));
      return team?.leadId ?? t.assigneeId;
    }
    return t.assigneeId;
  }
  const [c] = await db.select({ employeeId: conversations.employeeId, teamId: conversations.teamId }).from(conversations).where(eq(conversations.id, data.conversationId));
  if (c?.employeeId) return c.employeeId;
  if (c?.teamId) {
    const [team] = await db.select({ leadId: teams.leadId }).from(teams).where(eq(teams.id, c.teamId));
    return team?.leadId ?? null;
  }
  return null;
}

export interface RunLeases {
  /** false: the employee or the division is at its limit; the job is delayed and nothing is held */
  ok: boolean;
  /** which limit refused the run (for logs and tests) */
  busy?: "employee" | "division";
  release: () => Promise<void>;
}

/**
 * The leases a run job holds while it is processed: one per employee (perEmployee runs at once), and for TASK runs one
 * per division of that employee (teams.max_parallel, across every worker process). Chat replies take only the employee
 * lease: they are interactive and must not queue behind a division's long task runs. A code lead's subagents work
 * inside its run, so they take no lease of their own.
 *
 * While held, the leases are renewed every `refreshMs` (a run can outlast the 30-minute lease TTL); release() stops
 * that and gives them back.
 */
export async function acquireRunLeases(data: RunJob, leaseId: string, perEmployee: number, opts: { refreshMs?: number } = {}): Promise<RunLeases> {
  const employeeId = await employeeForRun(data);
  if (employeeId && !(await acquireEmployeeLease(employeeId, leaseId, perEmployee))) return { ok: false, busy: "employee", release: async () => {} };
  let divisionId: string | null = null;
  try {
    const div = employeeId && data.kind === "task" ? await employeeDivision(employeeId) : null;
    if (div) {
      divisionId = div.division.id;
      if (!(await acquireDivisionLease(divisionId, leaseId, Math.max(1, div.division.maxParallel)))) {
        await releaseEmployeeLease(employeeId!, leaseId);
        return { ok: false, busy: "division", release: async () => {} };
      }
    }
  } catch (e) {
    // never keep a lease of a job that is not going to run: it would block the employee until the TTL
    if (divisionId) await releaseDivisionLease(divisionId, leaseId).catch(() => {});
    if (employeeId) await releaseEmployeeLease(employeeId, leaseId).catch(() => {});
    throw e;
  }
  const refresh = () =>
    void Promise.all([
      employeeId ? refreshEmployeeLease(employeeId, leaseId) : null,
      divisionId ? refreshDivisionLease(divisionId, leaseId) : null,
    ]).catch((e: unknown) => log.warn({ err: e, leaseId }, "lease refresh failed"));
  const timer = employeeId ? setInterval(refresh, opts.refreshMs ?? LEASE_REFRESH_MS) : null;
  timer?.unref();
  return {
    ok: true,
    release: async () => {
      if (timer) clearInterval(timer);
      if (divisionId) await releaseDivisionLease(divisionId, leaseId).catch(() => {});
      if (employeeId) await releaseEmployeeLease(employeeId, leaseId);
    },
  };
}
