import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agentWorkOnRepository, approvals, audit, db, MERGE_TOOL, repositories, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";

const schema = z.object({
  /** merge: into the default branch now; skip: this version stays out of it (it no longer shows as waiting) */
  decision: z.enum(["merge", "skip"]),
  /** the pushed commit the person looked at: refused when the task pushed something newer meanwhile */
  head: z.string().regex(/^[0-9a-f]{40}$/),
  note: z.string().trim().max(500).optional(),
});

/**
 * A person's decision about a finished task's pushed work: merge it into the repository's default branch (the worker
 * fast-forwards or writes a merge commit and pushes it, never forced), or leave it out. Stored as a merge_branch
 * approval decided by this person, so the code panel, the app page and the audit log show who decided what.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { decision, head, note } = await body(req, schema);
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound("task_not_found");
  if (!t.repositoryId) throw new HttpError(409, "This task has no repository", { code: "merge_no_repository" });
  if (t.status !== "DONE") throw new HttpError(409, "Only finished work can be merged", { code: "merge_task_not_done" });
  const [repo] = await db.select({ id: repositories.id, defaultBranch: repositories.defaultBranch }).from(repositories).where(eq(repositories.id, t.repositoryId));
  if (!repo) throw new HttpError(409, "This task has no repository", { code: "merge_no_repository" });
  const [work] = await agentWorkOnRepository(session.workspaceId, repo.id, { taskIds: [t.id] });
  if (!work) throw new HttpError(409, "Nothing of this task was pushed yet", { code: "merge_nothing_pushed" });
  if (work.head !== head) throw new HttpError(409, "The task pushed a newer version meanwhile", { code: "merge_head_changed" });

  const id = await db.transaction(async (tx) => {
    // the same lock as the worker's merge scan: one decision per pushed commit at a time
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wfos-merge:${t.id}`}))`);
    const open = await tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(and(eq(approvals.taskId, t.id), eq(approvals.toolName, MERGE_TOOL), inArray(approvals.status, ["APPROVED", "EXECUTING", "EXECUTED"]), sql`${approvals.payload}->>'head' = ${head}`));
    if (open.some((o) => o.status === "EXECUTED")) throw new HttpError(409, "Already merged", { code: "merge_already_done" });
    if (open.length) throw new HttpError(409, "A merge of this version is under way", { code: "merge_in_progress" });
    const [row] = await tx
      .insert(approvals)
      .values({
        workspaceId: session.workspaceId,
        taskId: t.id,
        employeeId: t.assigneeId,
        toolName: MERGE_TOOL,
        title: decision === "merge" ? `Merge ${work.branch} into ${repo.defaultBranch}` : `Leave ${work.branch} out of ${repo.defaultBranch}`,
        reason: note ?? "",
        payload: { repositoryId: repo.id, head, branch: work.branch, base: repo.defaultBranch, title: t.title },
        status: decision === "merge" ? "APPROVED" : "REJECTED",
        decidedBy: session.userId,
        decidedAt: new Date(),
        feedback: note ?? null,
      })
      .returning({ id: approvals.id });
    return row!.id;
  });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: decision === "merge" ? "task.merge_approved" : "task.merge_skipped",
    targetType: "task",
    targetId: t.id,
    details: { approvalId: id, repositoryId: repo.id, branch: work.branch, head, base: repo.defaultBranch, note: note ?? null },
  });
  await publish(session.workspaceId, { type: "approval.updated", approvalId: id, status: decision === "merge" ? "APPROVED" : "REJECTED" });
  if (decision === "merge") await q.action({ kind: "execute_approval", approvalId: id, workspaceId: session.workspaceId });
  return { approvalId: id };
});
