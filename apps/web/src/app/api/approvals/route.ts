import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { approvals, db, employees, tasks } from "@wfos/db";
import { APPROVAL_STATUSES, APPROVAL_UNDECIDABLE_TASK_STATUSES, type ApprovalStatus } from "@wfos/shared";
import { route } from "@/lib/server/route";
import { offBranchApprovals } from "@/app/api/conversations/[id]/thread";

/**
 * The inbox. `olderVersion`: raised in a chat by a message that is not on the conversation's active branch any
 * more (someone switched to another version) — still decidable, since switching back brings it into view again.
 * A pending approval of a task whose employee is still working (RUNNING / QUEUED) cannot be decided yet: it is left
 * out (and out of the counts) until the run ends, and only `waiting` says how many there are.
 */
export const GET = route("VIEWER", async ({ session, req }) => {
  const st = req.nextUrl.searchParams.get("status");
  const conds: SQL[] = [eq(approvals.workspaceId, session.workspaceId)];
  const statuses = st?.split(",").filter((s): s is ApprovalStatus => (APPROVAL_STATUSES as readonly string[]).includes(s));
  if (statuses?.length) conds.push(inArray(approvals.status, statuses));
  const rows = await db
    .select({
      approval: approvals,
      employee: { id: employees.id, name: employees.name, avatar: employees.avatar, role: employees.role },
      task: { id: tasks.id, title: tasks.title, dryRun: tasks.dryRun, source: tasks.source, status: tasks.status },
    })
    .from(approvals)
    .leftJoin(employees, eq(employees.id, approvals.employeeId))
    .leftJoin(tasks, eq(tasks.id, approvals.taskId))
    .where(and(...conds))
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  const undecidable = (r: (typeof rows)[number]) =>
    r.approval.status === "PENDING" && !!r.task?.status && (APPROVAL_UNDECIDABLE_TASK_STATUSES as readonly string[]).includes(r.task.status);
  const shown = rows.filter((r) => !undecidable(r));
  const older = await offBranchApprovals(session.workspaceId, shown.map((r) => r.approval));
  return {
    approvals: shown.map((r) => ({ ...r.approval, employee: r.employee, task: r.task, olderVersion: older.has(r.approval.id) })),
    waiting: rows.length - shown.length,
  };
});
