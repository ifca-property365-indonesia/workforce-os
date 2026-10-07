import { db, workspaces } from "@wfos/db";
import { eq } from "drizzle-orm";
import { log } from "../lib/logger";

/** Active runs, keyed by run id, so the kill switch / cancel can abort them immediately. */
interface ActiveRun {
  workspaceId: string;
  taskId: string | null;
  employeeId: string;
  controller: AbortController;
}
const active = new Map<string, ActiveRun>();

export function registerRun(runId: string, run: ActiveRun): void {
  active.set(runId, run);
}
export function unregisterRun(runId: string): void {
  active.delete(runId);
}
export function activeRunCount(): number {
  return active.size;
}

export function abortWorkspace(workspaceId: string, reason: string): number {
  let n = 0;
  for (const [, r] of active) {
    if (r.workspaceId === workspaceId) {
      r.controller.abort(new Error(reason));
      n++;
    }
  }
  if (n) log.warn({ workspaceId, n }, "aborted runs (kill switch)");
  return n;
}

export function abortTask(taskId: string, reason: string): number {
  let n = 0;
  for (const [, r] of active) {
    if (r.taskId === taskId) {
      r.controller.abort(new Error(reason));
      n++;
    }
  }
  return n;
}

export async function isKilled(workspaceId: string): Promise<boolean> {
  const [ws] = await db.select({ k: workspaces.killSwitch }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return !!ws?.k;
}
