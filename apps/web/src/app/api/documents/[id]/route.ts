import { and, eq } from "drizzle-orm";
import { unlink } from "node:fs/promises";
import { db, documents } from "@wfos/db";
import { route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";

type P = { id: string };

export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  const [d] = await db.delete(documents).where(and(eq(documents.id, params.id), eq(documents.workspaceId, session.workspaceId))).returning();
  if (d) await unlink(d.storagePath).catch(() => {});
  return { ok: true };
});

/** Re-index a document. */
export const POST = route<P>("MEMBER", async ({ session, params }) => {
  const [d] = await db.update(documents).set({ status: "pending" }).where(and(eq(documents.id, params.id), eq(documents.workspaceId, session.workspaceId))).returning();
  if (d) await q.ingest(d.id, session.workspaceId);
  return { ok: true };
});
