import { and, eq } from "drizzle-orm";
import { db, routines } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";

export const POST = route<{ id: string }>("MEMBER", async ({ session, params }) => {
  const [r] = await db.select({ id: routines.id }).from(routines).where(and(eq(routines.id, params.id), eq(routines.workspaceId, session.workspaceId)));
  if (!r) notFound();
  await q.misc({ kind: "routine_run", routineId: r.id, workspaceId: session.workspaceId, userId: session.userId });
  return { ok: true };
});
