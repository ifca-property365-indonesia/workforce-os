import { and, eq } from "drizzle-orm";
import { TASK_SOURCES, type TaskSource } from "@wfos/shared";
import type { DB } from "./index";
import { clients, employees, projects, repositories, tasks, teams } from "./schema";

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
  repositoryId?: string | null;
  parentTaskId?: string | null;
  originTaskId?: string | null;
  routineId?: string | null;
  dryRun?: boolean;
  phase?: string | null;
  createdBy?: string | null;
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
 * repository, parent and origin task) must belong to the task's workspace, or a TaskInputError is thrown.
 * Publishing task.created and enqueueing stay with the caller.
 */
export async function createTask(database: Database, input: CreateTaskInput): Promise<TaskRow> {
  const ws = input.workspaceId;
  if (!(TASK_SOURCES as readonly string[]).includes(input.source)) throw new TaskInputError("invalid_task_source");
  if ((input.requireAssignee ?? true) && !input.assigneeId && !input.teamId) throw new TaskInputError("task_needs_assignee");

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
  if (input.teamId) {
    const [team] = UUID.test(input.teamId)
      ? await database.select({ id: teams.id, leadId: teams.leadId }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, ws))).limit(1)
      : [];
    if (!team) throw new TaskInputError("unknown_team");
    if (team.leadId) {
      if (!(await owned(employees, team.leadId))) throw new TaskInputError("unknown_team_lead");
    } else if (input.requireTeamLead ?? true) {
      throw new TaskInputError("team_has_no_lead");
    }
  }
  if (input.clientId && !(await owned(clients, input.clientId))) throw new TaskInputError("unknown_client");
  if (input.projectId && !(await owned(projects, input.projectId))) throw new TaskInputError("unknown_project");
  if (input.repositoryId && !(await owned(repositories, input.repositoryId))) throw new TaskInputError("repository_not_found");
  if (input.parentTaskId && !(await owned(tasks, input.parentTaskId))) throw new TaskInputError("unknown_parent_task");
  if (input.originTaskId && !(await owned(tasks, input.originTaskId))) throw new TaskInputError("unknown_origin_task");

  const [row] = await database
    .insert(tasks)
    .values({
      workspaceId: ws,
      title: input.title,
      brief: input.brief ?? "",
      assigneeId: input.assigneeId ?? null,
      teamId: input.teamId ?? null,
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      repositoryId: input.repositoryId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      originTaskId: input.originTaskId ?? null,
      routineId: input.routineId ?? null,
      source: input.source,
      dryRun: input.dryRun ?? false,
      status: "QUEUED",
      phase: input.phase ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row!;
}
