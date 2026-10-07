import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db, steps, tasks } from "@wfos/db";
import { route } from "@/lib/server/route";

/** Activity timeline for a task (and its subtasks when ?include=children). */
export const GET = route<{ id: string }>("VIEWER", async ({ session, req, params }) => {
  const includeChildren = req.nextUrl.searchParams.get("include") === "children";
  let ids = [params.id];
  if (includeChildren) {
    const kids = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentTaskId, params.id));
    ids = ids.concat(kids.map((k) => k.id));
  }
  const rows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.workspaceId, session.workspaceId), or(inArray(steps.taskId, ids))))
    .orderBy(asc(steps.createdAt));
  return { steps: rows };
});
