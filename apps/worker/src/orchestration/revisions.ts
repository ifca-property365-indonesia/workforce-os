import { and, eq, isNotNull, sql } from "drizzle-orm";
import { agentMessages, db, tasks } from "@wfos/db";

/** How often a division head may send one subtask back with request_revision. */
export const MAX_REVISIONS_PER_SUBTASK = 2;

/** Revisions a subtask already had: the head's review messages to it (intent review, from an employee). */
export async function revisionsUsed(subtaskId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentMessages)
    .where(and(eq(agentMessages.taskId, subtaskId), eq(agentMessages.intent, "review"), isNotNull(agentMessages.fromEmployeeId)));
  return Number(r?.n ?? 0);
}

/**
 * Why request_revision cannot send this subtask back (null: it can). Checked when the head calls the tool, so the head
 * learns it at once and can still decide (accept with notes, or fail the task) instead of the run finishing on a
 * revision that is then silently skipped.
 */
export async function revisionRefusal(o: { parentTaskId: string; subtaskId: string; pending: { taskId: string }[] }): Promise<string | null> {
  const [child] = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, o.subtaskId), eq(tasks.parentTaskId, o.parentTaskId)));
  if (!child) return `${o.subtaskId} is not a subtask of this task.`;
  if (o.pending.some((p) => p.taskId === child.id)) return `A revision of "${child.title}" is already requested in this review.`;
  if (child.status !== "DONE") {
    return `"${child.title}" is ${child.status}: only a DONE subtask can be sent back for revision${child.status === "FAILED" ? " (use retry_subtask or reassign_subtask for a failed one)" : ""}.`;
  }
  const used = await revisionsUsed(child.id);
  if (used >= MAX_REVISIONS_PER_SUBTASK) {
    return (
      `"${child.title}" has already had its ${MAX_REVISIONS_PER_SUBTASK} revisions, so it cannot be sent back again. Decide now with finish_review: ` +
      'outcome "accept" if the result is usable, with notes on what is missing or should follow up, or outcome "fail" with notes that explain exactly what is missing against the acceptance criteria.'
    );
  }
  return null;
}
