// Task phases of ordered subtasks (tasks.depends_on). No imports: shared by the tool registry and the orchestration.

/** QUEUED subtask waiting for its dependencies (not enqueued yet). */
export const PHASE_AFTER = "after";
/** QUEUED subtask that cannot start: a dependency ended FAILED or CANCELLED (or is itself blocked). */
export const PHASE_BLOCKED = "blocked";
export const DEPENDENCY_PHASES: string[] = [PHASE_AFTER, PHASE_BLOCKED];
