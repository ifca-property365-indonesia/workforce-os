import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, employees, nextCronRun, workflows } from "@wfos/db";
import { workflowInputSchema, type WorkflowInput } from "@wfos/shared";
import { HttpError } from "./auth";
import { notFound } from "./route";

/** A workflow of the workspace, or 404. */
export async function loadWorkflow(workspaceId: string, id: string) {
  const [w] = await db.select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.workspaceId, workspaceId)));
  if (!w) notFound();
  return w;
}

/**
 * A workflow as a person saves it: the shared schema, a cron that parses, and employees of this workspace only (an
 * id from another workspace would otherwise get a task there).
 */
export async function validateWorkflow(workspaceId: string, raw: unknown): Promise<WorkflowInput> {
  const parsed = workflowInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), { code: "invalid_workflow" });
  const w = parsed.data;
  if (w.trigger.kind === "schedule") nextRun(w.trigger);
  const ids = [...new Set(w.steps.flatMap((s) => (s.kind === "agent" ? [s.employeeId] : [])))];
  const known = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.workspaceId, workspaceId), inArray(employees.id, ids)));
  if (known.length !== ids.length) throw new HttpError(400, "A step names an employee outside this workspace", { code: "workflow_unknown_employee" });
  return w;
}

/** The next firing of a schedule trigger (400 invalid_cron when it does not parse). */
export function nextRun(trigger: { cron: string; timezone: string }, from = new Date()): Date {
  try {
    return nextCronRun(trigger.cron, trigger.timezone, from);
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`, { code: "invalid_cron", detail: (e as Error).message });
  }
}
