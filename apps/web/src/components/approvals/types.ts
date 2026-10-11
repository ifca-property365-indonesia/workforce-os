/** An approval as the inbox and the chat show it. The chat's ChatApprovalDTO is a subset (no employee/task). */
export interface Approval {
  id: string;
  toolName: string;
  title: string;
  reason: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  status: string;
  feedback: string | null;
  executionResult: Record<string, unknown> | null;
  guardFindings?: { rule: string; severity: string; excerpt: string }[];
  createdAt: string;
  decidedAt: string | null;
  employee?: { id: string; name: string; avatar: string; role: string } | null;
  task?: { id: string; title: string; dryRun: boolean; source: string } | null;
  /** inbox only: raised by a chat message that is not on the conversation's active branch (another version is shown) */
  olderVersion?: boolean;
}

export interface Email {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

/** The execution summary the worker writes, if any. */
export function resultSummary(a: Pick<Approval, "executionResult">): string | null {
  const s = a.executionResult?.summary;
  return typeof s === "string" && s ? s : null;
}
