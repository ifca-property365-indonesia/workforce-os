import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { approvals, db, employees, tasks } from "@wfos/db";
import { APPROVAL_STATUSES, type ApprovalStatus } from "@wfos/shared";
import { route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session, req }) => {
  const st = req.nextUrl.searchParams.get("status");
  const conds: SQL[] = [eq(approvals.workspaceId, session.workspaceId)];
  const statuses = st?.split(",").filter((s): s is ApprovalStatus => (APPROVAL_STATUSES as readonly string[]).includes(s));
  if (statuses?.length) conds.push(inArray(approvals.status, statuses));
  const rows = await db
    .select({
      approval: approvals,
      employee: { id: employees.id, name: employees.name, avatar: employees.avatar, role: employees.role },
      task: { id: tasks.id, title: tasks.title, dryRun: tasks.dryRun, source: tasks.source },
    })
    .from(approvals)
    .leftJoin(employees, eq(employees.id, approvals.employeeId))
    .leftJoin(tasks, eq(tasks.id, approvals.taskId))
    .where(and(...conds))
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  return { approvals: rows.map((r) => ({ ...r.approval, employee: r.employee, task: r.task })) };
});
