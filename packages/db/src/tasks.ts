import { and, eq, inArray } from "drizzle-orm";
import { TASK_SOURCES, type TaskReviewPolicy, type TaskSource, type TaskWorkMode } from "@wfos/shared";
import type { DB } from "./index";
import { clients, employees, goals, projects, repositories, tasks, teams } from "./schema";

/** Why createTask() refused its input. Each code has an `errors.<code>` message in the web catalogs. */
export const TASK_INPUT_ERROR_CODES = [
  "task_needs_assignee",
  "unknown_employee",
  "unknown_team",
  "team_has_no_lead",
  "unknown_team_lead",
  "unknown_client",
  "unknown_project",
  "repository_not_found",
  "unknown_parent_task",
  "unknown_origin_task",
  "invalid_task_source",
  "project_client_mismatch",
  "invalid_dependency",
  "unknown_goal",
] as const;
export type TaskInputErrorCode = (typeof TASK_INPUT_ERROR_CODES)[number];

const MESSAGES: Record<TaskInputErrorCode, string> = {
  task_needs_assignee: "Assign the task to an employee or a team",
  unknown_employee: "Unknown employee",
  unknown_team: "Unknown team",
  team_has_no_lead: "This team has no Lead",
  unknown_team_lead: "The team's Lead is not an employee of this workspace",
  unknown_client: "Unknown client",
  unknown_project: "Unknown project",
  repository_not_found: "Unknown repository",
  unknown_parent_task: "Unknown parent task",
  unknown_origin_task: "Unknown origin task",
  invalid_task_source: "Invalid task source",
  project_client_mismatch: "The project belongs to another client",
  invalid_dependency: "A subtask can only wait for other subtasks of the same parent",
  unknown_goal: "Unknown goal",
};

export class TaskInputError extends Error {
  constructor(public readonly code: TaskInputErrorCode) {
    super(MESSAGES[code]);
    this.name = "TaskInputError";
  }
}

export type TaskRow = typeof tasks.$inferSelect;

export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  brief?: string;
  source: TaskSource;
  assigneeId?: string | null;
  teamId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  /** P1: the goal it serves; when not given: the parent's, the origin task's or the project's */
  goalId?: string | null;
  /** P4: what the task may do (default: the parent's, else standard) */
  workMode?: TaskWorkMode;
  /** P4: who accepts the result (default auto) */
  reviewPolicy?: TaskReviewPolicy;
  repositoryId?: string | null;
  parentTaskId?: string | null;
  originTaskId?: string | null;
  /** sibling subtasks (same parent) that must be DONE first; their deliverables are passed in as data */
  dependsOn?: string[];
  routineId?: string | null;
  dryRun?: boolean;
  phase?: string | null;
  createdBy?: string | null;
  /** created from untrusted input (a webhook payload): the run starts tainted (default false) */
  untrustedInput?: boolean;
  /** refuse a task with neither assignee nor team (default true, as on the board) */
  requireAssignee?: boolean;
  /** refuse a team whose Lead is not set (default true, as on the board) */
  requireTeamLead?: boolean;
}

/** Anything that can select and insert: the db or a transaction. */
type Database = Pick<DB, "select" | "insert">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one way to create a task. Every referenced row (assignee, team and its Lead, client, project,
 * repository, parent and origin task, dependencies) must belong to the task's workspace, or a TaskInputError is thrown.
 * A project task without an assignee goes to the project's division; its client is the project's client.
 * Publishing task.created and enqueueing stay with the caller.
 */
export async function createTask(database: Database, input: CreateTaskInput): Promise<TaskRow> {
  const ws = input.workspaceId;
  if (!(TASK_SOURCES as readonly string[]).includes(input.source)) throw new TaskInputError("invalid_task_source");
  let teamId = input.teamId ?? null;
  let clientId = input.clientId ?? null;
  let projectGoalId: string | null = null;
  if (input.projectId) {
    const [project] = UUID.test(input.projectId)
      ? await database
          .select({ clientId: projects.clientId, teamId: projects.teamId, goalId: projects.goalId })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, ws)))
          .limit(1)
      : [];
    if (!project) throw new TaskInputError("unknown_project");
    // the project fixes the client: client-scoped knowledge and memory must not be crossed by a mismatched pair
    if (clientId && clientId !== project.clientId) throw new TaskInputError("project_client_mismatch");
    clientId = project.clientId;
    projectGoalId = project.goalId;
    if (!input.assigneeId && !teamId) teamId = project.teamId;
  }
  if ((input.requireAssignee ?? true) && !input.assigneeId && !teamId) throw new TaskInputError("task_needs_assignee");

  /** true when the id is set and names a row of this workspace in the given table */
  const owned = async (
    table: typeof employees | typeof clients | typeof projects | typeof repositories | typeof tasks,
    id: string,
  ): Promise<boolean> => {
    if (!UUID.test(id)) return false;
    const [row] = await database.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.workspaceId, ws))).limit(1);
    return !!row;
  };

  if (input.assigneeId && !(await owned(employees, input.assigneeId))) throw new TaskInputError("unknown_employee");
  if (teamId) {
    const [team] = UUID.test(teamId)
      ? await database.select({ id: teams.id, leadId: teams.leadId }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, ws))).limit(1)
      : [];
    if (!team) throw new TaskInputError("unknown_team");
    if (team.leadId) {
      if (!(await owned(employees, team.leadId))) throw new TaskInputError("unknown_team_lead");
    } else if (input.requireTeamLead ?? true) {
      throw new TaskInputError("team_has_no_lead");
    }
  }
  if (clientId && !(await owned(clients, clientId))) throw new TaskInputError("unknown_client");
  if (input.repositoryId && !(await owned(repositories, input.repositoryId))) throw new TaskInputError("repository_not_found");
  if (input.parentTaskId && !(await owned(tasks, input.parentTaskId))) throw new TaskInputError("unknown_parent_task");
  if (input.originTaskId && !(await owned(tasks, input.originTaskId))) throw new TaskInputError("unknown_origin_task");
  // P1: a goal given must be this workspace's; else the parent's, the origin task's or the project's
  let goalId = input.goalId ?? null;
  // P4: work started from an ask-only or plan-only task (a subtask, a follow-up, a handoff) is never allowed more than
  // it: a mode asked for only applies when the task it comes from is standard
  let workMode: TaskWorkMode = input.workMode ?? "standard";
  for (const from of [input.parentTaskId, input.originTaskId]) {
    if (!from) continue;
    const [p] = await database.select({ workMode: tasks.workMode }).from(tasks).where(and(eq(tasks.id, from), eq(tasks.workspaceId, ws))).limit(1);
    if (p && p.workMode !== "standard" && workMode === "standard") workMode = p.workMode;
  }
  if (goalId) {
    const [g] = UUID.test(goalId) ? await database.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.workspaceId, ws))).limit(1) : [];
    if (!g) throw new TaskInputError("unknown_goal");
  } else if (input.goalId === undefined) {
    for (const from of [input.parentTaskId, input.originTaskId]) {
      if (goalId || !from) continue;
      const [t] = await database.select({ goalId: tasks.goalId }).from(tasks).where(and(eq(tasks.id, from), eq(tasks.workspaceId, ws))).limit(1);
      goalId = t?.goalId ?? null;
    }
    goalId ??= projectGoalId;
  }
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  if (dependsOn.length) {
    if (!input.parentTaskId || dependsOn.some((id) => !UUID.test(id))) throw new TaskInputError("invalid_dependency");
    const siblings = await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.id, dependsOn), eq(tasks.workspaceId, ws), eq(tasks.parentTaskId, input.parentTaskId)));
    if (siblings.length !== dependsOn.length) throw new TaskInputError("invalid_dependency");
  }

  const [row] = await database
    .insert(tasks)
    .values({
      workspaceId: ws,
      title: input.title,
      brief: input.brief ?? "",
      assigneeId: input.assigneeId ?? null,
      teamId,
      clientId,
      projectId: input.projectId ?? null,
      goalId,
      workMode,
      reviewPolicy: input.reviewPolicy ?? "auto",
      repositoryId: input.repositoryId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      originTaskId: input.originTaskId ?? null,
      dependsOn,
      routineId: input.routineId ?? null,
      source: input.source,
      dryRun: input.dryRun ?? false,
      status: "QUEUED",
      phase: input.phase ?? null,
      createdBy: input.createdBy ?? null,
      untrustedInput: input.untrustedInput ?? false,
    })
    .returning();
  return row!;
}
