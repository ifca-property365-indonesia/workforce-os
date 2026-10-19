import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };
export { audit } from "./audit";
export { seedSampleData, seedOrganization, seedPrices, nextCronRun, type SeededDivision } from "./sample";
export * from "./claude";
export { llmSpendUsd, firstLlmStepAt, usageMeter, recordUsageCalibration, scheduleFor, type UsageMeter } from "./usage-meter";
export { employeeDivision, divisionSubagents, workspaceDivisions, type DivisionRow } from "./divisions";
export { getOrCreateWorkspaceSshKey, workspaceSshPrivateKey, type WorkspaceSshKey } from "./ssh-key";
export { agentWorkOnRepository, MERGE_TOOL, type AgentWork, type MergeDecision, type MergeState } from "./agent-work";
export { createTask, TaskInputError, TASK_INPUT_ERROR_CODES, type CreateTaskInput, type TaskInputErrorCode, type TaskRow } from "./tasks";
export {
  appModuleViews,
  activeModuleWork,
  lockAppModules,
  moduleAppOfTask,
  moduleSlug,
  moduleTaskTree,
  MODULE_SLUG,
  requestModuleWork,
  startModuleWork,
  takeQueuedModuleWork,
  type AppModuleStatus,
  type AppModuleTaskRef,
  type AppModuleView,
  type ModuleWorkInput,
} from "./app-modules";

export type DB = PostgresJsDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __wfosDb?: DB; __wfosSql?: postgres.Sql };

export function getSql(): postgres.Sql {
  if (!globalForDb.__wfosSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__wfosSql = postgres(url, {
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return globalForDb.__wfosSql;
}

export function getDb(): DB {
  if (!globalForDb.__wfosDb) globalForDb.__wfosDb = drizzle(getSql(), { schema });
  return globalForDb.__wfosDb;
}

/** Lazy proxy so importing modules does not require DATABASE_URL at build time. */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});
export { employeeMetrics, metricScore, ACTIVE_GAP_MIN, MIN_TASKS_FOR_SCORE } from "./hr-metrics";
