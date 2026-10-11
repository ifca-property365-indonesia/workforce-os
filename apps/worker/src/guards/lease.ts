import { redis } from "../lib/redis";

// ---------------------------------------------------------------------------
// Per-employee concurrency: a lease set in Redis (stale leases expire after 30 min).
// Members are BullMQ job ids; task jobs are `task-<taskId>-<enqueuedAt>` (see enqueueTask).
// ---------------------------------------------------------------------------
export const LEASE_TTL_MS = 30 * 60 * 1000;

export const employeeLeaseKey = (employeeId: string) => `wfos:emp-lease:${employeeId}`;

export async function acquireEmployeeLease(employeeId: string, leaseId: string, limit: number): Promise<boolean> {
  const key = employeeLeaseKey(employeeId);
  const now = Date.now();
  const res = await redis
    .multi()
    .zremrangebyscore(key, 0, now - LEASE_TTL_MS)
    .zadd(key, now, leaseId)
    .zcard(key)
    .pexpire(key, LEASE_TTL_MS)
    .exec();
  const count = Number(res?.[2]?.[1] ?? 0);
  if (count > limit) {
    await redis.zrem(key, leaseId);
    return false;
  }
  return true;
}

export async function releaseEmployeeLease(employeeId: string, leaseId: string): Promise<void> {
  await redis.zrem(employeeLeaseKey(employeeId), leaseId);
}

/** Task ids (of `candidates`) that hold a live lease of `employeeId`, i.e. a job of theirs is being processed by some worker. */
export async function tasksHoldingLease(employeeId: string, candidates: readonly string[]): Promise<Set<string>> {
  const members = await redis.zrangebyscore(employeeLeaseKey(employeeId), Date.now() - LEASE_TTL_MS, "+inf");
  return new Set(candidates.filter((id) => members.some((m) => m.startsWith(`task-${id}-`))));
}
