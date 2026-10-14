import { vi } from "vitest";
import type { OutgoingMail, SmtpConfig } from "@wfos/shared/mail";

/** Recorded side effects of the mock transports. Reset between tests with resetTransport(). */
export const transport = {
  mails: [] as { cfg: SmtpConfig; mail: OutgoingMail }[],
  published: [] as { workspaceId: string; ev: unknown }[],
  queued: [] as { queue: string; name: string; data: unknown; opts?: { delay?: number; jobId?: string } }[],
  blockedFetches: [] as string[],
};

export function resetTransport() {
  zsets.clear();
  kv.clear();
  transport.mails.length = 0;
  transport.published.length = 0;
  transport.queued.length = 0;
  transport.blockedFetches.length = 0;
}

function fakeQueue(queue: string) {
  // getJobs on the prototype: a test may set its own and `delete` it again, the default (nothing queued) comes back
  const q = Object.create({ getJobs: async () => [] as unknown[] }) as { add: unknown };
  q.add = vi.fn(async (name: string, data: unknown, opts?: { delay?: number; jobId?: string }) => void transport.queued.push({ queue, name, data, ...(opts ? { opts } : {}) }));
  return q as { add: ReturnType<typeof vi.fn>; getJobs: () => Promise<unknown[]> };
}

/** In-memory sorted sets: enough Redis for the lease/slot code (zadd, zrem, zcard, zremrangebyscore, multi). */
const zsets = new Map<string, Map<string, number>>();
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!;
const zops = {
  // ZADD key [XX] score member
  zadd: (k: string, ...a: (string | number)[]) => {
    const xx = a[0] === "XX";
    const [score, m] = (xx ? a.slice(1) : a) as [number, string];
    if (xx && !z(k).has(m)) return 0;
    z(k).set(m, score);
    return 1;
  },
  zrem: (k: string, m: string) => (z(k).delete(m) ? 1 : 0),
  zcard: (k: string) => z(k).size,
  zremrangebyscore: (k: string, min: number, max: number) => {
    let n = 0;
    for (const [m, s] of z(k)) {
      if (s >= min && s <= max) {
        z(k).delete(m);
        n++;
      }
    }
    return n;
  },
  pexpire: () => 1,
};
function fakeMulti() {
  const ops: (() => unknown)[] = [];
  const chain = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) =>
      name === "exec"
        ? async () => ops.map((f) => [null, f()])
        : (...args: unknown[]) => {
            ops.push(() => (zops as Record<string, (...a: unknown[]) => unknown>)[name]!(...args));
            return chain;
          },
  });
  return chain;
}
/** Plain keys: SET with NX only (enough for once-per-day claims). */
const kv = new Map<string, string>();
async function set(k: string, v: string, ...opts: unknown[]) {
  if (opts.includes("NX") && kv.has(k)) return null;
  kv.set(k, v);
  return "OK";
}

export const redisModule = {
  newRedis: () => ({ subscribe: vi.fn(), on: vi.fn(), disconnect: vi.fn() }),
  redis: { publish: vi.fn(), disconnect: vi.fn(), multi: fakeMulti, zrem: async (k: string, m: string) => zops.zrem(k, m), zscore: async (k: string, m: string) => z(k).get(m)?.toString() ?? null, set, get: async (k: string) => kv.get(k) ?? null, del: async (k: string) => (kv.delete(k) ? 1 : 0) },
  connection: { url: "redis://mock" },
  prefix: "wfos-test",
  runsQueue: fakeQueue("runs"),
  actionsQueue: fakeQueue("actions"),
  ingestQueue: fakeQueue("ingest"),
  miscQueue: fakeQueue("misc"),
  deploysQueue: fakeQueue("deploys"),
  publish: vi.fn(async (workspaceId: string, ev: unknown) => void transport.published.push({ workspaceId, ev })),
  CONTROL_CHANNEL: "wfos-test:wfos:control",
  enqueueTask: vi.fn(async (taskId: string, workspaceId: string, resumeNote?: string) =>
    void transport.queued.push({ queue: "runs", name: "task", data: { taskId, workspaceId, resumeNote } }),
  ),
};

export const mailModule = {
  sendMail: vi.fn(async (cfg: SmtpConfig, mail: OutgoingMail) => {
    transport.mails.push({ cfg, mail });
    return { messageId: `<mock-${transport.mails.length}@test>`, accepted: [...mail.to] };
  }),
};

const vec = Array.from({ length: 384 }, (_, i) => (i % 7) / 7 + 0.01);
export const embeddingsModule = {
  embedOne: vi.fn(async () => vec),
  embed: vi.fn(async (texts: string[]) => texts.map(() => vec)),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
};
