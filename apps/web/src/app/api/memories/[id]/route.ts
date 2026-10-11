import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, memories } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { notFound, patchBody, route } from "@/lib/server/route";
import { journal, memorySnapshot } from "@/lib/server/memory-journal";

type P = { id: string };
const schema = z.object({
  content: z.string().min(2).max(2000),
  kind: z.enum(["fact", "feedback", "preference"]),
  /** null clears the expiry */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

/** Edit a memory (journaled). The untrusted mark stays: a person editing the text does not vouch for where it came from. */
export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await patchBody(req, schema.partial());
  if (!Object.keys(input).length) throw new HttpError(400, "Nothing to change", { code: "nothing_to_change" });
  await db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, params.id), eq(memories.workspaceId, session.workspaceId)))
      .for("update");
    if (!cur) notFound();
    const contentChanged = input.content !== undefined && input.content !== cur.content;
    const [next] = await tx
      .update(memories)
      .set({
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}),
        ...(contentChanged ? { embedding: null } : {}),
      })
      .where(eq(memories.id, cur.id))
      .returning();
    await journal(tx, { workspaceId: session.workspaceId, employeeId: cur.employeeId, memoryId: cur.id, action: "update", actorUserId: session.userId, before: memorySnapshot(cur), after: memorySnapshot(next!) });
  });
  return { ok: true };
});

/** Delete a memory (journaled, so it can be undone from the History panel). */
export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  await db.transaction(async (tx) => {
    const [cur] = await tx
      .delete(memories)
      .where(and(eq(memories.id, params.id), eq(memories.workspaceId, session.workspaceId)))
      .returning();
    if (!cur) return;
    await journal(tx, { workspaceId: session.workspaceId, employeeId: cur.employeeId, memoryId: cur.id, action: "delete", actorUserId: session.userId, before: memorySnapshot(cur), after: null });
  });
  return { ok: true };
});
