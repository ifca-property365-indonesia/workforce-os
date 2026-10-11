import { and, eq, isNull, lte } from "drizzle-orm";
import { clients, createTask, db, memories, nextCronRun, routineRuns, routines, TaskInputError } from "@wfos/db";
import { enqueueTask, publish } from "../lib/redis";
import { log } from "../lib/logger";
import { embed } from "../lib/embeddings";
import { errorMessage } from "../lib/errors";

type Routine = typeof routines.$inferSelect;

function render(brief: string, client?: typeof clients.$inferSelect): string {
  if (!client) return brief.replace(/\{\{\s*client\.[a-z]+\s*\}\}/g, "each client");
  return brief.replace(/\{\{\s*client\.name\s*\}\}/g, client.name).replace(/\{\{\s*client\.id\s*\}\}/g, client.id).replace(/\{\{\s*client\.email\s*\}\}/g, client.email);
}

/**
 * Create the task(s) for one routine firing. Unattended runs go through the same tool gate.
 * If a firing fails part-way (client N's task cannot be created or enqueued), the routine run is
 * recorded as failed with the error AND the ids of the tasks already created (they still run), so
 * they stay attached to the firing; the error is then rethrown.
 */
export async function dispatchRoutine(r: Routine, trigger: "schedule" | "manual", userId?: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    await createRoutineTasks(r, userId, ids);
  } catch (e) {
    await db
      .insert(routineRuns)
      .values({ routineId: r.id, trigger, taskIds: ids, status: "failed", error: errorMessage(e) })
      .catch((e2: unknown) => log.error({ err: e2, routineId: r.id }, "recording the failed routine run failed"));
    throw e;
  }
  await db.insert(routineRuns).values({ routineId: r.id, trigger, taskIds: ids, status: "dispatched" });
  await db.update(routines).set({ lastRunAt: new Date() }).where(eq(routines.id, r.id));
  return ids;
}

/** Creates and enqueues the firing's tasks, pushing each id onto `ids` as soon as the task exists. */
async function createRoutineTasks(r: Routine, userId: string | undefined, ids: string[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const targets = r.perClient ? await db.select().from(clients).where(eq(clients.workspaceId, r.workspaceId)) : [undefined];
  for (const c of targets) {
    // a routine whose assignee or team points outside its workspace throws here (the run is recorded as failed)
    const t = await createTask(db, {
      workspaceId: r.workspaceId,
      title: `${r.name}${c ? ` — ${c.name}` : ""} (${date})`,
      brief: render(r.brief, c) + (c ? `\n\nClient id: ${c.id}` : ""),
      assigneeId: r.assigneeId,
      teamId: r.teamId,
      clientId: c?.id ?? null,
      routineId: r.id,
      source: "routine",
      dryRun: r.dryRun,
      createdBy: userId ?? null,
      // unchanged: a routine whose assignee was removed, or whose team lost its Lead, still dispatches
      requireAssignee: false,
      requireTeamLead: false,
    });
    ids.push(t.id);
    await publish(r.workspaceId, { type: "task.created", taskId: t.id, title: t.title, employeeId: t.assigneeId });
    await enqueueTask(t.id, r.workspaceId);
  }
}

/**
 * The misc `routine_run` job ("Run now"). A refused reference (TaskInputError: assignee or team
 * outside the workspace) fails the same way on every attempt, so it is not rethrown: dispatchRoutine
 * already recorded the failed run with its error, and BullMQ retries would only repeat it.
 */
export async function runRoutineJob(routineId: string, userId?: string): Promise<string[]> {
  const [r] = await db.select().from(routines).where(eq(routines.id, routineId));
  if (!r) return [];
  try {
    return await dispatchRoutine(r, "manual", userId);
  } catch (e) {
    if (e instanceof TaskInputError) {
      log.warn({ routineId: r.id, code: e.code }, "manual routine run refused");
      return [];
    }
    throw e;
  }
}

/** Called every 30s. Claims due routines atomically (safe with multiple workers). */
export async function tickRoutines(): Promise<void> {
  const due = await db.select().from(routines).where(and(eq(routines.enabled, true), lte(routines.nextRunAt, new Date())));
  for (const r of due) {
    let next: Date;
    try {
      next = nextCronRun(r.cron, r.timezone);
    } catch (e) {
      log.error({ err: e, routineId: r.id }, "invalid cron; disabling routine");
      await db.update(routines).set({ enabled: false }).where(eq(routines.id, r.id));
      continue;
    }
    const claimed = await db
      .update(routines)
      .set({ nextRunAt: next })
      // claim: only one worker can move a due routine's next_run_at into the future
      .where(and(eq(routines.id, r.id), lte(routines.nextRunAt, new Date())))
      .returning({ id: routines.id });
    if (!claimed.length) continue;
    try {
      const ids = await dispatchRoutine(r, "schedule");
      log.info({ routineId: r.id, tasks: ids.length }, "routine dispatched");
    } catch (e) {
      log.error({ err: e, routineId: r.id }, "routine dispatch failed"); // dispatchRoutine recorded the failed run
    }
  }
  // Ensure enabled routines without nextRunAt get one.
  const missing = await db.select().from(routines).where(and(eq(routines.enabled, true), isNull(routines.nextRunAt)));
  for (const r of missing) {
    try {
      await db.update(routines).set({ nextRunAt: nextCronRun(r.cron, r.timezone) }).where(eq(routines.id, r.id));
    } catch {
      /* invalid cron handled above next tick */
    }
  }
}

/** Memories edited by users in the UI are stored without embeddings; fill them in. */
export async function backfillMemoryEmbeddings(): Promise<void> {
  const rows = await db.select({ id: memories.id, content: memories.content }).from(memories).where(isNull(memories.embedding)).limit(32);
  if (!rows.length) return;
  const vecs = await embed(rows.map((r) => r.content));
  for (let i = 0; i < rows.length; i++) {
    await db.update(memories).set({ embedding: vecs[i]! }).where(eq(memories.id, rows[i]!.id));
  }
}
