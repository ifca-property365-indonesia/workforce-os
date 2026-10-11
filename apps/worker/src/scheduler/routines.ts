import { and, desc, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
import { clients, createTask, db, memories, nextCronRun, routineRuns, routines, tasks, TaskInputError } from "@wfos/db";
import { ROUTINE_CATCH_UP_MS, TERMINAL_STATUSES } from "@wfos/shared";
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
      // proposed by a tainted run: its tasks start tainted (every irreversible action needs approval)
      untrustedInput: r.untrustedInput,
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

/**
 * True while the routine's latest dispatched firing still has a task that has not ended
 * (routine_runs.status stays "dispatched" until settleRoutineRun sees every task end).
 */
export async function previousRunOpen(routineId: string): Promise<boolean> {
  const [run] = await db
    .select({ taskIds: routineRuns.taskIds })
    .from(routineRuns)
    .where(and(eq(routineRuns.routineId, routineId), eq(routineRuns.status, "dispatched")))
    .orderBy(desc(routineRuns.startedAt))
    .limit(1);
  if (!run?.taskIds.length) return false;
  const [open] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, run.taskIds), notInArray(tasks.status, [...TERMINAL_STATUSES])))
    .limit(1);
  return !!open;
}

/** A firing that did not run: terminal at insert ("missed" / "skipped_overlap"), so settleRoutineRun never touches it. */
async function recordSkippedRun(r: Routine, status: "missed" | "skipped_overlap", error: string): Promise<void> {
  await db.insert(routineRuns).values({ routineId: r.id, trigger: "schedule", taskIds: [], status, error });
}

/**
 * Called every 30s. Claims due routines atomically (safe with multiple workers), then per firing:
 * more than ROUTINE_CATCH_UP_MS late (the worker was down) → recorded as "missed", not run (one row however many
 * firings were missed; next_run_at moves to the next future firing); the previous firing still running and
 * overlap "skip" → recorded as "skipped_overlap"; otherwise (or overlap "queue") dispatched once.
 */
export async function tickRoutines(now: Date = new Date()): Promise<void> {
  const due = await db.select().from(routines).where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)));
  for (const r of due) {
    let next: Date;
    try {
      next = nextCronRun(r.cron, r.timezone, now);
    } catch (e) {
      log.error({ err: e, routineId: r.id }, "invalid cron; disabling routine");
      await db.update(routines).set({ enabled: false }).where(eq(routines.id, r.id));
      continue;
    }
    const claimed = await db
      .update(routines)
      .set({ nextRunAt: next })
      // claim: only one worker can move a due routine's next_run_at into the future
      .where(and(eq(routines.id, r.id), lte(routines.nextRunAt, now)))
      .returning({ id: routines.id });
    if (!claimed.length) continue;
    const scheduledFor = r.nextRunAt!;
    try {
      if (now.getTime() - scheduledFor.getTime() > ROUTINE_CATCH_UP_MS) {
        await recordSkippedRun(r, "missed", `Scheduled for ${scheduledFor.toISOString()}; more than ${ROUTINE_CATCH_UP_MS / 3_600_000} h late, so it was not run.`);
        log.warn({ routineId: r.id, scheduledFor }, "routine firing missed (too late to catch up)");
        continue;
      }
      if (r.overlap !== "queue" && (await previousRunOpen(r.id))) {
        await recordSkippedRun(r, "skipped_overlap", "The previous run was still in progress.");
        log.info({ routineId: r.id }, "routine firing skipped: previous run still in progress");
        continue;
      }
    } catch (e) {
      log.error({ err: e, routineId: r.id }, "routine policy check failed");
      continue;
    }
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
      await db.update(routines).set({ nextRunAt: nextCronRun(r.cron, r.timezone, now) }).where(eq(routines.id, r.id));
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
