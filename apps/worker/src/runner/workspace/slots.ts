import { readFile } from "node:fs/promises";
import { redis } from "../../lib/redis";
import { env } from "../../lib/env";

/**
 * Host-wide admission of Workspace-mode runs (each is a Claude Code process of 300+ MB plus whatever it builds).
 *
 * - At most WORKSPACE_CONCURRENCY sandboxes at once (default 1 on small hosts).
 * - A second (third, …) sandbox also needs the memory: what the host has available, minus what the running
 *   sandboxes may still grow into (their MemoryMax minus what they use now), must cover its MemoryMax plus
 *   WORKSPACE_MEMORY_RESERVE_MB. The first sandbox is always admitted, as before.
 * - A lease lives LEASE_TTL_MS and the run renews it while it works, so a run may last for hours while a crashed
 *   worker still frees its slot within minutes.
 * - Tasks refused a slot are listed as waiting for a short while; a long run hands its slot over when one is waiting.
 */
const ns = () => (env.namespace ? `${env.namespace}:` : "");
const LEASES = () => `${ns()}wfos:workspace-slots`;
const LEASE_MEMORY = () => `${ns()}wfos:workspace-slot-memory`;
const WAITING = () => `${ns()}wfos:workspace-waiting`;
const ADMIT_LOCK = () => `${ns()}wfos:workspace-admit`;

export const LEASE_TTL_MS = 5 * 60_000;
/** how often a run renews its lease */
export const LEASE_RENEW_MS = 60_000;
/** a refused task retries every 15 s; one that stopped retrying no longer counts as waiting */
const WAITING_TTL_MS = 60_000;

export function workspaceConcurrency(): number {
  return Math.max(1, Number(process.env.WORKSPACE_CONCURRENCY ?? 1));
}

/** A running sandbox as the memory check sees it. */
export interface SandboxMemory {
  maxMb: number;
  /** null: its unit has not started yet (or is gone): counted at its full limit */
  currentMb: number | null;
}

/**
 * Pure admission rule: available host memory minus what the running sandboxes may still grow into must cover the
 * new sandbox's limit plus the reserve. With no other sandbox running, always yes (the unit's own MemoryMax holds it).
 */
export function memoryAdmits(o: { availableMb: number; reserveMb: number; needMb: number; others: SandboxMemory[] }): boolean {
  if (!o.others.length) return true;
  const growth = o.others.reduce((a, s) => a + Math.max(0, s.maxMb - (s.currentMb ?? 0)), 0);
  return o.availableMb - growth >= o.needMb + o.reserveMb;
}

export interface HostProbe {
  availableMb: () => Promise<number>;
  /** memory the sandbox unit of this run uses now, null when it has no unit */
  unitCurrentMb: (runId: string) => Promise<number | null>;
}

const realProbe: HostProbe = {
  availableMb: async () => {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile("/proc/meminfo", "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : 0;
  },
  // the run's unit is a system service (systemd-run without --user): its cgroup counts everything it started
  unitCurrentMb: async (runId) =>
    readFile(`/sys/fs/cgroup/system.slice/wfos-run-${runId}.service/memory.current`, "utf8").then(
      (s) => Math.ceil(Number(s.trim()) / 1024 / 1024),
      () => null,
    ),
};
let probe: HostProbe = realProbe;
/** Tests: a fake host (null = the real one). */
export function setHostProbe(p: HostProbe | null): void {
  probe = p ?? realProbe;
}

export type SlotRefusal = { ok: false; reason: "slots" | "memory"; firstWait: boolean };
export type SlotResult = { ok: true } | SlotRefusal;

export async function acquireWorkspaceSlot(req: { runId: string; taskId: string; memoryMaxMb: number }): Promise<SlotResult> {
  const now = Date.now();
  const refuse = async (reason: SlotRefusal["reason"]): Promise<SlotRefusal> => {
    const res = await redis.multi().zremrangebyscore(WAITING(), 0, now - WAITING_TTL_MS).zadd(WAITING(), now, req.taskId).exec();
    return { ok: false, reason, firstWait: Number(res?.[1]?.[1] ?? 0) === 1 };
  };
  // one admission at a time across all workers: two runs measuring the same free memory would both fit
  const locked = await redis.set(ADMIT_LOCK(), req.runId, "PX", 10_000, "NX");
  if (!locked) return refuse("slots");
  try {
    const expired = await redis.zrangebyscore(LEASES(), 0, now - LEASE_TTL_MS);
    if (expired.length) await redis.multi().zrem(LEASES(), ...expired).hdel(LEASE_MEMORY(), ...expired).exec();
    const others = await redis.zrange(LEASES(), 0, -1);
    if (others.length >= workspaceConcurrency()) return await refuse("slots");
    if (others.length) {
      const maxes = await redis.hmget(LEASE_MEMORY(), ...others);
      const running = await Promise.all(others.map(async (id, i) => ({ maxMb: Number(maxes[i]) || req.memoryMaxMb, currentMb: await probe.unitCurrentMb(id) })));
      const ok = memoryAdmits({ availableMb: await probe.availableMb(), reserveMb: env.workspaceMemoryReserveMb, needMb: req.memoryMaxMb, others: running });
      if (!ok) return await refuse("memory");
    }
    await redis.multi().zadd(LEASES(), now, req.runId).hset(LEASE_MEMORY(), req.runId, String(req.memoryMaxMb)).zrem(WAITING(), req.taskId).exec();
    return { ok: true };
  } finally {
    // only our own lock (it may have expired and been taken by another admission)
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, ADMIT_LOCK(), req.runId);
  }
}

/** Keeps a running sandbox's lease alive (the run calls it every LEASE_RENEW_MS). */
export async function renewWorkspaceSlot(runId: string): Promise<void> {
  await redis.zadd(LEASES(), "XX", Date.now(), runId);
}

export async function releaseWorkspaceSlot(runId: string): Promise<void> {
  await redis.multi().zrem(LEASES(), runId).hdel(LEASE_MEMORY(), runId).exec();
}

/** Other tasks that were refused a sandbox slot within the last minute (and keep retrying). */
export async function tasksWaitingForSlot(exceptTaskId?: string): Promise<number> {
  await redis.zremrangebyscore(WAITING(), 0, Date.now() - WAITING_TTL_MS);
  const ids = await redis.zrange(WAITING(), 0, -1);
  return ids.filter((id) => id !== exceptTaskId).length;
}
