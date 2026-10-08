/**
 * Operations: worker heartbeat and the health verdict shown by /api/health (and used by deploy/upgrade.sh).
 */

export function heartbeatKey(namespace = ""): string {
  return `${namespace ? `${namespace}:` : ""}wfos:health:worker`;
}

/** Heartbeat the worker writes every HEARTBEAT_EVERY_MS with a TTL; a missing or old one means the worker is down. */
export interface WorkerHeartbeat {
  at: string;
  pid: number;
  commit: string | null;
  activeRuns: number;
  sandbox: { available: boolean; runner: boolean; claude: boolean };
}
export const HEARTBEAT_EVERY_MS = 20_000;
export const HEARTBEAT_STALE_MS = 75_000;

export interface HealthInput {
  db: boolean;
  redis: boolean;
  heartbeat: WorkerHeartbeat | null;
  /** any employee in Workspace mode: only then does a missing sandbox degrade the instance */
  workspaceModeInUse: boolean;
  now: number;
}

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  checks: {
    db: boolean;
    redis: boolean;
    worker: { ok: boolean; ageSec: number | null };
    sandbox: { ok: boolean; required: boolean; runner: boolean; claude: boolean } | null;
  };
  commit: string | null;
}

/**
 * down: the web cannot serve (db or redis unreachable). degraded: the web serves but work does not run (no fresh
 * worker heartbeat), or Workspace-mode employees exist and the sandbox is not ready. ok: everything needed works.
 */
export function evaluateHealth(i: HealthInput): HealthReport {
  const age = i.heartbeat ? Math.max(0, Math.round((i.now - Date.parse(i.heartbeat.at)) / 1000)) : null;
  const workerOk = age !== null && age * 1000 <= HEARTBEAT_STALE_MS;
  const sb = i.heartbeat?.sandbox;
  const sandbox = sb ? { ok: sb.available && sb.runner && sb.claude, required: i.workspaceModeInUse, runner: sb.runner, claude: sb.claude } : null;
  const status = !i.db || !i.redis ? "down" : !workerOk || (i.workspaceModeInUse && !sandbox?.ok) ? "degraded" : "ok";
  return { status, checks: { db: i.db, redis: i.redis, worker: { ok: workerOk, ageSec: age }, sandbox }, commit: i.heartbeat?.commit ?? null };
}
