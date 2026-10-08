import { redis } from "../../lib/redis";
import { env } from "../../lib/env";

/**
 * Host-wide limit on concurrent Workspace-mode runs (each is a Claude Code process of 300+ MB plus whatever it
 * builds). Default 1 on small hosts; WORKSPACE_CONCURRENCY raises it. Stale leases expire after the unit's
 * maximum runtime, so a crashed worker cannot block the host forever.
 */
const KEY = () => `${env.namespace ? `${env.namespace}:` : ""}wfos:workspace-slots`;
const TTL_MS = (Number(process.env.WORKSPACE_RUNTIME_MAX_SEC ?? 3600) + 120) * 1000;

export function workspaceConcurrency(): number {
  return Math.max(1, Number(process.env.WORKSPACE_CONCURRENCY ?? 1));
}

export async function acquireWorkspaceSlot(runId: string): Promise<boolean> {
  const now = Date.now();
  const res = await redis.multi().zremrangebyscore(KEY(), 0, now - TTL_MS).zadd(KEY(), now, runId).zcard(KEY()).exec();
  const count = Number(res?.[2]?.[1] ?? 0);
  if (count > workspaceConcurrency()) {
    await redis.zrem(KEY(), runId);
    return false;
  }
  return true;
}

export async function releaseWorkspaceSlot(runId: string): Promise<void> {
  await redis.zrem(KEY(), runId);
}
