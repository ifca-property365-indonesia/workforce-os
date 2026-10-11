import "server-only";
import { createTask, TaskInputError, type CreateTaskInput, type TaskRow } from "@wfos/db";
import { HttpError } from "./auth";

/** createTask() for routes: a refused reference becomes a 400 with its translated errors.<code>. */
export async function createTaskOr400(database: Parameters<typeof createTask>[0], input: CreateTaskInput): Promise<TaskRow> {
  try {
    return await createTask(database, input);
  } catch (e) {
    if (e instanceof TaskInputError) {
      // i18n-ignore: every TASK_INPUT_ERROR_CODES entry has an errors.<code> message (checked in test/tasks.test.ts)
      throw new HttpError(400, e.message, { code: e.code });
    }
    throw e;
  }
}
