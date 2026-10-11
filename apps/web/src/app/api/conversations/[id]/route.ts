import { and, eq } from "drizzle-orm";
import { conversations, db } from "@wfos/db";
import { route } from "@/lib/server/route";
import { conversationIn, threadView } from "./thread";

type P = { id: string };

/** The conversation's active branch (edits and regenerations fork; the other versions are reachable via `branch`). */
export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const c = await conversationIn(session.workspaceId, params.id);
  return threadView(c, session.workspaceId);
});

export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  await db.delete(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  return { ok: true };
});
