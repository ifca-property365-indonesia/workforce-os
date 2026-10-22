import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employees, workflowRuns, workflows } from "@wfos/db";
import { body, route } from "@/lib/server/route";
import { validateWorkflow } from "@/lib/server/workflows";

/** Workflows of the workspace, each with its last run. */
export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(workflows).where(eq(workflows.workspaceId, session.workspaceId)).orderBy(desc(workflows.createdAt));
  const runs = rows.length
    ? await db
        .selectDistinctOn([workflowRuns.workflowId], { workflowId: workflowRuns.workflowId, status: workflowRuns.status, createdAt: workflowRuns.createdAt })
        .from(workflowRuns)
        .where(inArray(workflowRuns.workflowId, rows.map((r) => r.id)))
        .orderBy(workflowRuns.workflowId, desc(workflowRuns.createdAt))
    : [];
  const people = await db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.workspaceId, session.workspaceId));
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  return {
    workflows: rows.map((w) => ({
      ...w,
      proposedBy: name(w.proposedByEmployeeId),
      lastRun: runs.find((r) => r.workflowId === w.id) ?? null,
    })),
  };
});

/** A person makes a workflow; it starts off (turned on with PATCH enabled). */
export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await validateWorkflow(session.workspaceId, await body(req, z.record(z.string(), z.unknown())));
  const [w] = await db
    .insert(workflows)
    .values({ workspaceId: session.workspaceId, name: input.name, description: input.description, trigger: input.trigger, steps: input.steps, createdBy: session.userId })
    .returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "workflow.created", targetType: "workflow", targetId: w!.id, details: { name: w!.name } });
  return { workflow: w };
});
