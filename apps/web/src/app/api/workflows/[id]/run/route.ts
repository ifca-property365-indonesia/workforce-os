import { and, eq, inArray } from "drizzle-orm";
import { audit, db, workflowRuns } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";
import { loadWorkflow } from "@/lib/server/workflows";

/** Run now (a person's click, also for a draft that is still off). Refused while a run of it is open. */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const w = await loadWorkflow(session.workspaceId, params.id);
  const [open] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, w.id), inArray(workflowRuns.status, ["running", "waiting"])))
    .limit(1);
  if (open) throw new HttpError(409, "A run of this workflow is still in progress", { code: "workflow_run_open" });
  await q.misc({ kind: "workflow_start", workspaceId: session.workspaceId, workflowId: w.id, userId: session.userId });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "workflow.run", targetType: "workflow", targetId: w.id, details: { name: w.name } });
  return { ok: true };
});
