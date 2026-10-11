import { db, memories, memoryEvents } from "@wfos/db";
import type { MemoryEventAction } from "@wfos/shared";

/** Who changed a memory (memory_events.actor). */
export type MemoryActor = "agent" | "user" | "tidy" | "import" | "rejection";

/** The fields of a memory the journal keeps before and after a change (enough to undo it). */
export interface MemorySnapshot {
  content: string;
  kind: string;
  expiresAt: string | null;
  supersededBy: string | null;
  untrusted: boolean;
}

type MemoryRow = Pick<typeof memories.$inferSelect, "content" | "kind" | "untrusted"> & {
  expiresAt?: Date | string | null;
  supersededBy?: string | null;
};

export function memorySnapshot(m: MemoryRow): MemorySnapshot {
  const exp = m.expiresAt ?? null;
  return {
    content: m.content,
    kind: m.kind,
    expiresAt: exp === null ? null : exp instanceof Date ? exp.toISOString() : new Date(exp).toISOString(),
    supersededBy: m.supersededBy ?? null,
    untrusted: m.untrusted,
  };
}

/** Anything that can insert: the db or a transaction. */
type Database = Pick<typeof db, "insert">;

export interface MemoryEventInput {
  workspaceId: string;
  employeeId: string;
  /** null only for an event about a memory that no longer exists */
  memoryId: string | null;
  action: MemoryEventAction;
  actor: MemoryActor;
  actorUserId?: string | null;
  before: MemorySnapshot | MemoryRow | null;
  after: MemorySnapshot | MemoryRow | null;
}

const snap = (m: MemorySnapshot | MemoryRow | null): MemorySnapshot | null => (m ? memorySnapshot(m) : null);

/**
 * Journal one change to an employee's memory (create / update / delete / expire / supersede / restore),
 * with the memory before and after it, so a person can see and undo it. Pass the transaction that made
 * the change so the change and its journal row commit together.
 */
export async function recordMemoryEvent(e: MemoryEventInput, database: Database = db): Promise<string> {
  const [row] = await database
    .insert(memoryEvents)
    .values({
      workspaceId: e.workspaceId,
      employeeId: e.employeeId,
      memoryId: e.memoryId,
      action: e.action,
      actor: e.actor,
      actorUserId: e.actorUserId ?? null,
      before: snap(e.before) as Record<string, unknown> | null,
      after: snap(e.after) as Record<string, unknown> | null,
    })
    .returning({ id: memoryEvents.id });
  return row!.id;
}
