import { and, eq, isNull, lte } from "drizzle-orm";
import { clients, db, memories, nextCronRun, routineRuns, routines, tasks } from "@wfos/db";
import { enqueueTask, publish } from "../lib/redis";
import { log } from "../lib/logger";
import { embed } from "../lib/embeddings";

type Routine = typeof routines.$inferSelect;

function render(brief: string, client?: typeof clients.$inferSelect): string {
  if (!client) return brief.replace(/\{\{\s*client\.[a-z]+\s*\}\}/g, "each client");
  return brief.replace(/\{\{\s*client\.name\s*\}\}/g, client.name).replace(/\{\{\s*client\.id\s*\}\}/g, client.id).replace(/\{\{\s*client\.email\s*\}\}/g, client.email);
}

/** Create the task(s) for one routine firing. Unattended runs go through the same tool gate. */
export async function dispatchRoutine(r: Routine, trigger: "schedule" | "manual", userId?: string): Promise<string[]> {
  const date = new Date().toISOString().slice(0, 10);
  const targets = r.perClient ? await db.select().from(clients).where(eq(clients.workspaceId, r.workspaceId)) : [undefined];
  const ids: string[] = [];
  for (const c of targets) {
    const [t] = await db
      .insert(tasks)
      .values({
        workspaceId: r.workspaceId,
        title: `${r.name}${c ? ` — ${c.name}` : ""} (${date})`,
        brief: render(r.brief, c) + (c ? `\n\nClient id: ${c.id}` : ""),
        assigneeId: r.assigneeId,
        teamId: r.teamId,
        clientId: c?.id ?? null,
        routineId: r.id,
        source: "routine",
        dryRun: r.dryRun,
        status: "QUEUED",
        createdBy: userId ?? null,
      })
      .returning();
    ids.push(t!.id);
    await publish(r.workspaceId, { type: "task.created", taskId: t!.id, title: t!.title, employeeId: t!.assigneeId });
    await enqueueTask(t!.id, r.workspaceId);
  }
  await db.insert(routineRuns).values({ routineId: r.id, trigger, taskIds: ids, status: "dispatched" });
  await db.update(routines).set({ lastRunAt: new Date() }).where(eq(routines.id, r.id));
  return ids;
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
      log.error({ err: e, routineId: r.id }, "routine dispatch failed");
      await db.insert(routineRuns).values({ routineId: r.id, trigger: "schedule", status: "failed", error: (e as Error).message });
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
