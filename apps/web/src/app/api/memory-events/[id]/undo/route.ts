import { and, eq, isNull } from "drizzle-orm";
import { db, employees, memories, memoryEvents } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { notFound, route } from "@/lib/server/route";
import { fromSnapshot, journal, memorySnapshot, sameAsSnapshot } from "@/lib/server/memory-journal";

type P = { id: string };

/**
 * Undo one journal entry: put the memory back the way it was before it (`before`), recreating a deleted memory
 * with the same id, or removing a memory the entry created. Marks the entry undone and journals a "restore",
 * which can itself be undone.
 *
 * Refused (409 memory_changed_since) when the memory changed after the entry (it no longer looks like the entry's
 * `after`): undoing would silently throw that later change away. `?force=1` undoes anyway. A restored memory
 * whose old expiry date has passed would come back already expired: its expiry is cleared (`expiryCleared`).
 */
export const POST = route<P>("MEMBER", async ({ session, req, params }) => {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const out = await db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(memoryEvents)
      .where(and(eq(memoryEvents.id, params.id), eq(memoryEvents.workspaceId, session.workspaceId)))
      .for("update");
    if (!ev) notFound("memory_event_not_found");
    if (ev.undoneAt) throw new HttpError(409, "Already undone", { code: "memory_event_already_undone" });
    if (!ev.memoryId) throw new HttpError(409, "This entry cannot be undone", { code: "memory_event_not_undoable" });
    const [emp] = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.id, ev.employeeId), eq(employees.workspaceId, session.workspaceId)));
    if (!emp) notFound("employee_not_found");

    const [cur] = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, ev.memoryId), eq(memories.workspaceId, session.workspaceId)))
      .for("update");
    const curSnap = cur ? memorySnapshot(cur) : null;
    if (!force && !sameAsSnapshot(cur ?? null, ev.after)) {
      throw new HttpError(409, "The memory changed after this entry", { code: "memory_changed_since" });
    }
    let restored: Record<string, unknown> | null = null;
    let expiryCleared = false;

    if (!ev.before) {
      // the entry created this memory: undoing it removes the memory again
      if (cur) await tx.delete(memories).where(eq(memories.id, cur.id));
    } else {
      const s = fromSnapshot(ev.before);
      if (!s.content) throw new HttpError(409, "This entry cannot be undone", { code: "memory_event_not_undoable" });
      // a superseding memory that is gone by now cannot be pointed at
      let supersededBy = s.supersededBy;
      if (supersededBy) {
        const [sup] = await tx.select({ id: memories.id }).from(memories).where(and(eq(memories.id, supersededBy), eq(memories.workspaceId, session.workspaceId)));
        if (!sup) supersededBy = null;
      }
      // coming back already expired would look like the undo did nothing: it comes back without an expiry
      let expiresAt = s.expiresAt;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        expiresAt = null;
        expiryCleared = true;
      }
      // where a memory came from is a fact about the row: the row's own source, else what the journal recorded
      const values = { kind: s.kind, content: s.content, source: cur?.source ?? s.source ?? "agent", untrusted: s.untrusted ?? cur?.untrusted ?? false, expiresAt, supersededBy };
      if (cur) {
        const [row] = await tx
          .update(memories)
          .set({ ...values, ...(cur.content !== s.content ? { embedding: null } : {}) })
          .where(eq(memories.id, cur.id))
          .returning();
        restored = memorySnapshot(row!);
      } else {
        const [row] = await tx
          .insert(memories)
          .values({ id: ev.memoryId, workspaceId: session.workspaceId, employeeId: ev.employeeId, ...values, ...(s.createdAt ? { createdAt: s.createdAt } : {}) })
          .returning();
        restored = memorySnapshot(row!);
      }
    }

    const marked = await tx
      .update(memoryEvents)
      .set({ undoneAt: new Date() })
      .where(and(eq(memoryEvents.id, ev.id), isNull(memoryEvents.undoneAt)))
      .returning({ id: memoryEvents.id });
    if (!marked.length) throw new HttpError(409, "Already undone", { code: "memory_event_already_undone" });
    const restore = await journal(tx, { workspaceId: session.workspaceId, employeeId: ev.employeeId, memoryId: ev.memoryId, action: "restore", actorUserId: session.userId, before: curSnap, after: restored });
    return { eventId: restore.id, memoryId: ev.memoryId, memory: restored, expiryCleared };
  });
  return { ok: true, ...out };
});
