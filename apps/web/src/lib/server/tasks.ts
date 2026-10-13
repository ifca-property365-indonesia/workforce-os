import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createTask, db, tasks, TaskInputError, type CreateTaskInput, type TaskRow } from "@wfos/db";
import { HttpError } from "./auth";

/** createTask() for routes: a refused reference becomes a 400 with its translated errors.<code>. */
export async function createTaskOr400(database: Parameters<typeof createTask>[0], input: CreateTaskInput): Promise<TaskRow> {
  try {
    return await createTask(database, input);
  } catch (e) {
    if (e instanceof TaskInputError) {
      // i18n-ignore: every TASK_INPUT_ERROR_CODES entry has an errors.<code> message (checked in test/tasks.test.ts)
      throw new HttpError(400, e.message, { code: e.code });
    }
    throw e;
  }
}

export interface TaskProgress {
  progress: number | null;
  progressNote: string | null;
  progressAt: Date | null;
  /** true when `progress` was worked out from the subtasks (nothing reported by the assignee) */
  progressDerived: boolean;
}

type SubtaskCount = { total: number; done: number };

/** done / total over subtasks; CANCELLED ones are left out of the total. null without (counted) subtasks. */
export function derivedProgress(c: SubtaskCount | undefined): number | null {
  return c && c.total > 0 ? Math.round((c.done / c.total) * 100) : null;
}

function withProgress<T extends { progress: number | null; progressNote: string | null; progressAt: Date | null }>(t: T, c: SubtaskCount | undefined): T & TaskProgress {
  if (t.progress !== null) return { ...t, progressDerived: false };
  const d = derivedProgress(c);
  return { ...t, progress: d, progressDerived: d !== null };
}

/**
 * Adds progressDerived (and the subtask-derived progress where the assignee reported none) to task rows: one grouped
 * query over the subtasks of every row that needs it, never one per task.
 */
export async function attachProgress<T extends { id: string; progress: number | null; progressNote: string | null; progressAt: Date | null }>(
  workspaceId: string,
  rows: T[],
): Promise<(T & TaskProgress)[]> {
  const ids = rows.filter((r) => r.progress === null).map((r) => r.id);
  const counts = new Map<string, SubtaskCount>();
  if (ids.length) {
    const grouped = await db
      .select({
        parentId: tasks.parentTaskId,
        total: sql<number>`(count(*) filter (where ${tasks.status} <> 'CANCELLED'))::int`,
        done: sql<number>`(count(*) filter (where ${tasks.status} = 'DONE'))::int`,
      })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.parentTaskId, ids)))
      .groupBy(tasks.parentTaskId);
    for (const g of grouped) if (g.parentId) counts.set(g.parentId, { total: g.total, done: g.done });
  }
  return rows.map((r) => withProgress(r, counts.get(r.id)));
}

/** The same for one task whose subtasks are already loaded. */
export function progressFromChildren<T extends { progress: number | null; progressNote: string | null; progressAt: Date | null }>(t: T, children: { status: string }[]): T & TaskProgress {
  const counted = children.filter((c) => c.status !== "CANCELLED");
  return withProgress(t, { total: counted.length, done: counted.filter((c) => c.status === "DONE").length });
}
