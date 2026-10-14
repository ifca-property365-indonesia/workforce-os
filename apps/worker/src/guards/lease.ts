import { redis } from "../lib/redis";

// ---------------------------------------------------------------------------
// Per-employee concurrency: a lease set in Redis (stale leases expire after 30 min).
// Members are BullMQ job ids; task jobs are `task-<taskId>-<enqueuedAt>` (see enqueueTask).
// ---------------------------------------------------------------------------
export const LEASE_TTL_MS = 30 * 60 * 1000;

export const employeeLeaseKey = (employeeId: string) => `wfos:emp-lease:${employeeId}`;
/** Per-division concurrency (teams.max_parallel): every task run of a division member holds one member of this set. */
export const divisionLeaseKey = (teamId: string) => `wfos:div-lease:${teamId}`;

export async function acquireEmployeeLease(employeeId: string, leaseId: string, limit: number): Promise<boolean> {
  return acquireLease(employeeLeaseKey(employeeId), leaseId, limit);
}

export async function releaseEmployeeLease(employeeId: string, leaseId: string): Promise<void> {
  await redis.zrem(employeeLeaseKey(employeeId), leaseId);
}

/** A run slot of the division (at most `limit` runs of its members at once, across every worker process). */
export async function acquireDivisionLease(teamId: string, leaseId: string, limit: number): Promise<boolean> {
  return acquireLease(divisionLeaseKey(teamId), leaseId, limit);
}

export async function releaseDivisionLease(teamId: string, leaseId: string): Promise<void> {
  await redis.zrem(divisionLeaseKey(teamId), leaseId);
}

/** Keep a held employee lease alive: a run longer than LEASE_TTL_MS must not look stale (to other workers or the reaper). */
export async function refreshEmployeeLease(employeeId: string, leaseId: string): Promise<void> {
  await refreshLease(employeeLeaseKey(employeeId), leaseId);
}

export async function refreshDivisionLease(teamId: string, leaseId: string): Promise<void> {
  await refreshLease(divisionLeaseKey(teamId), leaseId);
}

/** New score for a lease still in the set (XX: a lease released meanwhile is not added back). */
async function refreshLease(key: string, leaseId: string): Promise<void> {
  await redis.multi().zadd(key, "XX", Date.now(), leaseId).pexpire(key, LEASE_TTL_MS).exec();
}

async function acquireLease(key: string, leaseId: string, limit: number): Promise<boolean> {
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

/** Task ids (of `candidates`) that hold a live lease of `employeeId`, i.e. a job of theirs is being processed by some worker. */
export async function tasksHoldingLease(employeeId: string, candidates: readonly string[]): Promise<Set<string>> {
  const members = await redis.zrangebyscore(employeeLeaseKey(employeeId), Date.now() - LEASE_TTL_MS, "+inf");
  return new Set(candidates.filter((id) => members.some((m) => m.startsWith(`task-${id}-`))));
}
