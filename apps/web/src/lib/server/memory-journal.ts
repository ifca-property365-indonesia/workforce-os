import "server-only";
import { db, memories, memoryEvents } from "@wfos/db";
import type { MemoryEventAction } from "@wfos/shared";

type Memory = typeof memories.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

/** What the journal keeps of a memory (no embedding: it is recomputed by the worker's backfill). */
export function memorySnapshot(m: Memory): Record<string, unknown> {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    source: m.source,
    untrusted: m.untrusted,
    /** the client the memory belongs to (null = general): an undo puts it back in the same scope */
    clientId: m.clientId ?? null,
    expiresAt: m.expiresAt?.toISOString() ?? null,
    supersededBy: m.supersededBy ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Columns to write back from a journal snapshot; tolerant of snapshots written by the worker (camelCase row fields). */
export function fromSnapshot(s: Record<string, unknown>) {
  return {
    kind: str(s.kind) ?? "fact",
    content: str(s.content) ?? "",
    /** null when the snapshot did not record it (the worker's journal leaves it out): keep what the row has */
    source: str(s.source),
    untrusted: typeof s.untrusted === "boolean" ? s.untrusted : null,
    /** undefined when the snapshot predates client scopes (keep what the row has, else general) */
    clientId: "clientId" in s || "client_id" in s ? str(s.clientId ?? s.client_id) : undefined,
    expiresAt: date(s.expiresAt ?? s.expires_at),
    supersededBy: str(s.supersededBy ?? s.superseded_by),
    createdAt: date(s.createdAt ?? s.created_at),
  };
}

/**
 * Does the memory still look the way a journal entry left it (`after`)? Compares what a person would notice —
 * content, kind, expiry, superseded-by — and only the fields the snapshot recorded (the worker's snapshots can be
 * partial). `after` null (a delete) means the memory must still be gone.
 */
export function sameAsSnapshot(cur: Memory | null, after: Record<string, unknown> | null): boolean {
  if (!after) return !cur;
  if (!cur) return false;
  const has = (k: string, alt?: string) => k in after || (alt !== undefined && alt in after);
  if (has("content") && str(after.content) !== cur.content) return false;
  if (has("kind") && str(after.kind) !== cur.kind) return false;
  if (has("expiresAt", "expires_at") && (date(after.expiresAt ?? after.expires_at)?.getTime() ?? null) !== (cur.expiresAt?.getTime() ?? null)) return false;
  if (has("supersededBy", "superseded_by") && str(after.supersededBy ?? after.superseded_by) !== (cur.supersededBy ?? null)) return false;
  return true;
}

export async function journal(
  tx: DbOrTx,
  e: { workspaceId: string; employeeId: string; memoryId: string | null; action: MemoryEventAction; actorUserId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null },
) {
  const [row] = await tx
    .insert(memoryEvents)
    .values({
      workspaceId: e.workspaceId,
      employeeId: e.employeeId,
      memoryId: e.memoryId,
      action: e.action,
      actor: "user",
      actorUserId: e.actorUserId,
      before: e.before,
      after: e.after,
    })
    .returning();
  return row!;
}

/** active = recalled; expired / superseded memories are kept (shown with "show inactive") but not recalled. */
export function memoryState(m: { expiresAt: Date | null; supersededBy: string | null }, now = Date.now()): "active" | "expired" | "superseded" {
  if (m.supersededBy) return "superseded";
  if (m.expiresAt && m.expiresAt.getTime() <= now) return "expired";
  return "active";
}
