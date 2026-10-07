import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, memories } from "@wfos/db";
import { body, notFound, route } from "@/lib/server/route";

type P = { id: string };
const schema = z.object({ content: z.string().min(2).max(2000), kind: z.enum(["fact", "feedback", "preference"]).optional() });

export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await body(req, schema);
  const r = await db
    .update(memories)
    .set({ ...input, embedding: null })
    .where(and(eq(memories.id, params.id), eq(memories.workspaceId, session.workspaceId)))
    .returning({ id: memories.id });
  if (!r.length) notFound();
  return { ok: true };
});

export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  await db.delete(memories).where(and(eq(memories.id, params.id), eq(memories.workspaceId, session.workspaceId)));
  return { ok: true };
});
