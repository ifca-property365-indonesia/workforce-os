import "server-only";
import { TERMINAL_STATUSES, type TaskStatus } from "@wfos/shared";

/** C3: a test still "running" whose task already ended (cancelled from the board, a lost run) shows as an error. */
export function effectiveTestStatus(status: string, taskStatus: TaskStatus | null): string {
  return status === "running" && taskStatus && (TERMINAL_STATUSES as readonly string[]).includes(taskStatus) ? "error" : status;
}
