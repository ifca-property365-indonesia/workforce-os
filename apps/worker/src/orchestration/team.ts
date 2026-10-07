import { db, tasks, teams, employees, agentMessages } from "@wfos/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { TERMINAL_STATUSES } from "@wfos/shared";
import { enqueueTask, publish } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { teamMemberIds, type TeamContext } from "../tools/registry";

/** Resolve who executes a task: the assignee, or the team lead for team-level tasks. */
export async function resolveExecutor(task: typeof tasks.$inferSelect): Promise<{ employeeId: string | null; team?: TeamContext }> {
  if (task.teamId && !task.parentTaskId) {
    const [team] = await db.select().from(teams).where(eq(teams.id, task.teamId));
    if (team?.leadId && (!task.assigneeId || task.assigneeId === team.leadId)) {
      const memberIds = (await teamMemberIds(team.id)).filter((id) => id !== team.leadId);
      const phase = task.phase === "review" ? "review" : "plan";
      return { employeeId: team.leadId, team: { teamId: team.id, role: "lead", phase, memberIds } };
    }
  }
  if (task.teamId && task.parentTaskId) {
    return { employeeId: task.assigneeId, team: { teamId: task.teamId, role: "member", phase: "work", memberIds: await teamMemberIds(task.teamId) } };
  }
  return { employeeId: task.assigneeId };
}

export async function planPrompt(task: typeof tasks.$inferSelect, team: TeamContext): Promise<string> {
  const members = team.memberIds.length
    ? await db.select({ id: employees.id, name: employees.name, role: employees.role }).from(employees).where(inArray(employees.id, team.memberIds))
    : [];
  return [
    "You are the team lead. Decompose the brief below into 2-5 bounded subtasks and delegate each with delegate_subtask to the best-suited member.",
    "Each subtask needs a clear title, a self-contained brief (members do not see this conversation) and acceptance criteria.",
    "Do not do the members' work yourself. After delegating, finish with a short plan summary.",
    `Team members:\n${members.map((m) => `- ${m.name} (${m.role}) id=${m.id}`).join("\n") || "(none)"}`,
  ].join("\n");
}

export async function reviewPrompt(task: typeof tasks.$inferSelect): Promise<string> {
  const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, task.id));
  const blocks = children.map((c) => {
    const ds = c.deliverables.map((d) => `#### ${d.title} (${d.kind})\n${d.content.slice(0, 6000)}`).join("\n\n");
    return `### Subtask ${c.id}: ${c.title} — ${c.status}\nResult: ${c.result ?? c.error ?? "(none)"}\n${ds}`;
  });
  return [
    "All subtasks have finished. Review each deliverable against its acceptance criteria.",
    "If one is not acceptable, call request_revision with specific feedback (once per subtask).",
    "If everything is acceptable, assemble the final deliverable with draft_document (kind review) and finish with a summary for the human.",
    blocks.join("\n\n"),
  ].join("\n\n");
}

/** Called whenever a subtask reaches a terminal state. Atomically flips the parent from wait → review. */
export async function onChildFinished(workspaceId: string, parentTaskId: string): Promise<void> {
  const children = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.parentTaskId, parentTaskId));
  if (children.some((c) => !TERMINAL_STATUSES.includes(c.status))) return;
  const flipped = await db
    .update(tasks)
    .set({ phase: "review" })
    .where(and(eq(tasks.id, parentTaskId), eq(tasks.phase, "wait")))
    .returning({ id: tasks.id, teamId: tasks.teamId });
  if (!flipped.length) return;
  await recordStep({ workspaceId, taskId: parentTaskId, kind: "system", name: "team_review_started", output: { subtasks: children.length } });
  await enqueueTask(parentTaskId, workspaceId);
}

export async function requestRevisions(workspaceId: string, parentTaskId: string, leadId: string, reqs: { taskId: string; feedback: string }[]): Promise<number> {
  let n = 0;
  for (const r of reqs) {
    const [child] = await db.select().from(tasks).where(and(eq(tasks.id, r.taskId), eq(tasks.parentTaskId, parentTaskId)));
    if (!child || child.status !== "DONE") continue;
    const previous = await db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(and(eq(agentMessages.taskId, child.id), eq(agentMessages.intent, "review"), isNotNull(agentMessages.fromEmployeeId)));
    if (previous.length >= 1) continue; // max one revision per subtask
    await db.insert(agentMessages).values({ workspaceId, taskId: child.id, fromEmployeeId: leadId, toEmployeeId: child.assigneeId, intent: "review", content: r.feedback });
    await db.update(tasks).set({ status: "QUEUED", completedAt: null }).where(eq(tasks.id, child.id));
    await publish(workspaceId, { type: "task.updated", taskId: child.id, status: "QUEUED" });
    await enqueueTask(child.id, workspaceId, `Your team lead requested a revision:\n${r.feedback}`);
    n++;
  }
  return n;
}
