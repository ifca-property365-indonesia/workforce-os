import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, workflowRuns, workflows } from "@wfos/db";
import { patchBody, route } from "@/lib/server/route";
import { loadWorkflow, nextRun, validateWorkflow } from "@/lib/server/workflows";

type P = { id: string };

/** One workflow and its last 20 runs (outputs cut to 2,000 characters each). */
export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const w = await loadWorkflow(session.workspaceId, params.id);
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, w.id)).orderBy(desc(workflowRuns.createdAt)).limit(20);
  return { workflow: w, runs: runs.map((r) => ({ ...r, outputs: r.outputs.map((o) => o.slice(0, 2000)) })) };
});

const patchSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    trigger: z.unknown(),
    steps: z.unknown(),
    enabled: z.boolean(),
  })
  .partial();

/**
 * Edit or turn on/off. Content changes are validated as a whole workflow; turning a scheduled workflow on sets its next
 * run. Only a person can turn a workflow on (an employee's propose_workflow draft starts off).
 */
export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const before = await loadWorkflow(session.workspaceId, params.id);
  const input = await patchBody(req, patchSchema);
  const content = input.name !== undefined || input.description !== undefined || input.trigger !== undefined || input.steps !== undefined;
  const next = content
    ? await validateWorkflow(session.workspaceId, {
        name: input.name ?? before.name,
        description: input.description ?? before.description,
        trigger: input.trigger ?? before.trigger,
        steps: input.steps ?? before.steps,
      })
    : { name: before.name, description: before.description, trigger: before.trigger, steps: before.steps };
  const enabled = input.enabled ?? before.enabled;
  const nextRunAt = enabled && next.trigger.kind === "schedule" ? nextRun(next.trigger) : null;
  const [w] = await db
    .update(workflows)
    .set({ ...next, enabled, nextRunAt, updatedAt: new Date() })
    .where(eq(workflows.id, before.id))
    .returning();
  const action = input.enabled === undefined || input.enabled === before.enabled ? "workflow.updated" : input.enabled ? "workflow.enabled" : "workflow.disabled";
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action,
    targetType: "workflow",
    targetId: w!.id,
    details: { name: w!.name, ...(content ? { steps: w!.steps.length, trigger: w!.trigger.kind } : {}), proposedByEmployeeId: before.proposedByEmployeeId },
  });
  return { workflow: w };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  const w = await loadWorkflow(session.workspaceId, params.id);
  await db.delete(workflows).where(eq(workflows.id, w.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "workflow.deleted", targetType: "workflow", targetId: w.id, details: { name: w.name } });
  return { ok: true };
});
