import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./index";
import { approvals, tasks } from "./schema";

/** The approval tool name of a decision about an agent branch: merge it into the default branch, or leave it out. */
export const MERGE_TOOL = "merge_branch";

export type MergeState = "unmerged" | "pending" | "merged" | "skipped" | "failed";

export interface MergeDecision {
  approvalId: string;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  summary: string | null;
  /** the merge commit on the default branch (or the pushed head itself after a fast-forward) */
  commit: string | null;
  conflicts: string[];
  /** found already in the default branch (merged outside Workforce OS), not merged by the platform */
  detected: boolean;
}

/** A task's latest pushed commit on a repository and what was decided about exactly that commit. */
export interface AgentWork {
  taskId: string;
  title: string;
  status: string;
  assigneeId: string | null;
  parentTaskId: string | null;
  branch: string;
  head: string;
  pushedAt: Date;
  state: MergeState;
  decision: MergeDecision | null;
}

function stateOf(d: MergeDecision | null): MergeState {
  if (!d) return "unmerged";
  if (d.status === "EXECUTED") return "merged";
  if (d.status === "REJECTED") return "skipped";
  if (d.status === "FAILED") return "failed";
  return "pending";
}

/**
 * Work the platform pushed for tasks on this repository (each task's latest executed git_push), newest first, with
 * the merge decision about that exact commit. A task pushed again after a merge is unmerged again.
 */
export async function agentWorkOnRepository(workspaceId: string, repositoryId: string, opts: { taskIds?: string[] } = {}): Promise<AgentWork[]> {
  const db = getDb();
  const where = [eq(approvals.workspaceId, workspaceId), eq(approvals.toolName, "git_push"), eq(approvals.status, "EXECUTED"), eq(tasks.repositoryId, repositoryId)];
  if (opts.taskIds) {
    if (!opts.taskIds.length) return [];
    where.push(inArray(tasks.id, opts.taskIds));
  }
  const pushes = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assigneeId: tasks.assigneeId,
      parentTaskId: tasks.parentTaskId,
      payload: approvals.payload,
      editedPayload: approvals.editedPayload,
      at: approvals.createdAt,
    })
    .from(approvals)
    .innerJoin(tasks, eq(tasks.id, approvals.taskId))
    .where(and(...where))
    .orderBy(desc(approvals.createdAt));
  const latest = new Map<string, (typeof pushes)[number]>();
  for (const p of pushes) if (!latest.has(p.taskId)) latest.set(p.taskId, p);
  if (!latest.size) return [];
  const merges = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.toolName, MERGE_TOOL), inArray(approvals.taskId, [...latest.keys()])))
    .orderBy(desc(approvals.createdAt));
  const out: AgentWork[] = [];
  for (const p of latest.values()) {
    const pushed = (p.editedPayload ?? p.payload) as { head?: unknown; branch?: unknown };
    const head = typeof pushed.head === "string" ? pushed.head : "";
    if (!/^[0-9a-f]{40}$/.test(head)) continue;
    const m = merges.find((x) => x.taskId === p.taskId && (x.payload as { head?: unknown }).head === head);
    const r = (m?.executionResult ?? {}) as { summary?: unknown; details?: { commit?: unknown; conflicts?: unknown; detected?: unknown } };
    const decision: MergeDecision | null = m
      ? {
          approvalId: m.id,
          status: m.status,
          decidedBy: m.decidedBy,
          decidedAt: m.decidedAt,
          createdAt: m.createdAt,
          summary: typeof r.summary === "string" ? r.summary : null,
          commit: typeof r.details?.commit === "string" ? r.details.commit : null,
          conflicts: Array.isArray(r.details?.conflicts) ? r.details.conflicts.filter((c): c is string => typeof c === "string") : [],
          detected: r.details?.detected === true,
        }
      : null;
    out.push({
      taskId: p.taskId,
      title: p.title,
      status: p.status,
      assigneeId: p.assigneeId,
      parentTaskId: p.parentTaskId,
      branch: typeof pushed.branch === "string" ? pushed.branch : `agent/${p.taskId}`,
      head,
      pushedAt: p.at,
      state: stateOf(decision),
      decision,
    });
  }
  return out;
}
