import { db, workspaces } from "@wfos/db";
import { eq } from "drizzle-orm";
import { log } from "../lib/logger";

/** Active runs, keyed by run id, so the kill switch / cancel can abort them immediately. */
interface ActiveRun {
  workspaceId: string;
  taskId: string | null;
  /** chat runs: the conversation being answered */
  conversationId?: string | null;
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
/** True while this process has an agent run registered for the task (the registry is per process). */
export function isTaskRunActive(taskId: string): boolean {
  for (const [, r] of active) if (r.taskId === taskId) return true;
  return false;
}

/** Conversations this process is answering right now (chat runs in the registry). */
export function activeConversationIds(): string[] {
  return [...new Set([...active.values()].map((r) => r.conversationId).filter((c): c is string => !!c))];
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
