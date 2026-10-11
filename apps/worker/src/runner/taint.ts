import { and, eq, inArray, sql } from "drizzle-orm";
import { db, messages, steps, tasks } from "@wfos/db";
import { log } from "../lib/logger";
import { TAINT_STEP_NAMES, type GuardCtx } from "../guards/content";

type Task = typeof tasks.$inferSelect;

/** How far up parent/origin links a task inherits untrusted input (a team plan, a follow-up of a follow-up). */
const UNTRUSTED_LINEAGE_DEPTH = 5;

/** True when the task, or a parent/origin task a few links up, was created from untrusted input. */
export async function untrustedLineage(task: Pick<Task, "untrustedInput" | "parentTaskId" | "originTaskId">): Promise<boolean> {
  if (task.untrustedInput) return true;
  let ids = [task.parentTaskId, task.originTaskId].filter((x): x is string => !!x);
  const seen = new Set<string>();
  for (let depth = 0; depth < UNTRUSTED_LINEAGE_DEPTH && ids.length; depth++) {
    const next: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const [t] = await db.select({ untrustedInput: tasks.untrustedInput, parentTaskId: tasks.parentTaskId, originTaskId: tasks.originTaskId }).from(tasks).where(eq(tasks.id, id));
      if (!t) continue;
      if (t.untrustedInput) return true;
      next.push(...[t.parentTaskId, t.originTaskId].filter((x): x is string => !!x));
    }
    ids = next;
  }
  return false;
}

/**
 * A task run that ended or paused tainted (a tool result with injection markers, untrusted stored input) marks its
 * task untrusted, so a resumed run (approval, revision, retry), the lead reviewing it, and tasks it spawns later
 * start tainted. Never cleared. Called before the run's status change, so whoever that wakes sees the mark.
 * Never throws: a failed write is logged (the run's own approvals were already forced).
 */
export async function persistRunTaint(guard: Pick<GuardCtx, "tainted">, task: Pick<Task, "id" | "untrustedInput">): Promise<void> {
  if (!guard.tainted || task.untrustedInput) return;
  try {
    await db.update(tasks).set({ untrustedInput: true }).where(and(eq(tasks.id, task.id), eq(tasks.untrustedInput, false)));
  } catch (e) {
    log.error({ err: e, taskId: task.id }, "taint of the run not persisted on its task");
  }
}

/** Mark chat rows as written while handling untrusted content (jsonb merge: the rest of meta is kept). */
export async function markMessagesUntrusted(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await db
      .update(messages)
      .set({ meta: sql`${messages.meta} || '{"untrusted":true}'::jsonb` })
      .where(inArray(messages.id, ids));
  } catch (e) {
    log.error({ err: e, messageIds: ids }, "chat: untrusted mark not stored");
  }
}

/**
 * Was the run that raised this approval tainted? Read from every place a taint is recorded: the payload mark,
 * the task's (lineage) flag, the chat reply's meta, and the guard steps of the task or conversation (these cover a
 * decision made while the run is still going, before its end-of-run marks are written).
 */
export async function approvalTainted(a: {
  taskId: string | null;
  conversationId: string | null;
  messageId: string | null;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  if (a.payload.untrustedInput === true) return true;
  if (a.taskId) {
    const [t] = await db.select({ untrustedInput: tasks.untrustedInput, parentTaskId: tasks.parentTaskId, originTaskId: tasks.originTaskId }).from(tasks).where(eq(tasks.id, a.taskId));
    if (t && (await untrustedLineage(t))) return true;
  }
  if (a.messageId) {
    const [m] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, a.messageId));
    if (m?.meta.untrusted === true) return true;
  }
  const scope = a.taskId ? eq(steps.taskId, a.taskId) : a.conversationId ? eq(steps.conversationId, a.conversationId) : null;
  if (!scope) return false;
  const [flag] = await db
    .select({ id: steps.id })
    .from(steps)
    .where(and(scope, eq(steps.kind, "guard"), eq(steps.status, "flagged"), inArray(steps.name, [...TAINT_STEP_NAMES])))
    .limit(1);
  return !!flag;
}
