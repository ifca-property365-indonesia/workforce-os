import { vi } from "vitest";
import type { OutgoingMail, SmtpConfig } from "@wfos/shared/mail";

/** Recorded side effects of the mock transports. Reset between tests with resetTransport(). */
export const transport = {
  mails: [] as { cfg: SmtpConfig; mail: OutgoingMail }[],
  published: [] as { workspaceId: string; ev: unknown }[],
  queued: [] as { queue: string; name: string; data: unknown }[],
  blockedFetches: [] as string[],
};

export function resetTransport() {
  zsets.clear();
  transport.mails.length = 0;
  transport.published.length = 0;
  transport.queued.length = 0;
  transport.blockedFetches.length = 0;
}

function fakeQueue(queue: string) {
  return { add: vi.fn(async (name: string, data: unknown) => void transport.queued.push({ queue, name, data })) };
}

/** In-memory sorted sets: enough Redis for the lease/slot code (zadd, zrem, zcard, zremrangebyscore, multi). */
const zsets = new Map<string, Map<string, number>>();
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!;
const zops = {
  zadd: (k: string, score: number, m: string) => (z(k).set(m, score), 1),
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
export function resetRedis() {
  zsets.clear();
}

export const redisModule = {
  newRedis: () => ({ subscribe: vi.fn(), on: vi.fn(), disconnect: vi.fn() }),
  redis: { publish: vi.fn(), disconnect: vi.fn(), multi: fakeMulti, zrem: async (k: string, m: string) => zops.zrem(k, m) },
  connection: { url: "redis://mock" },
  prefix: "wfos-test",
  runsQueue: fakeQueue("runs"),
  actionsQueue: fakeQueue("actions"),
  ingestQueue: fakeQueue("ingest"),
  miscQueue: fakeQueue("misc"),
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
