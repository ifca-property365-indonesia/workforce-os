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
  transport.mails.length = 0;
  transport.published.length = 0;
  transport.queued.length = 0;
  transport.blockedFetches.length = 0;
}

function fakeQueue(queue: string) {
  return { add: vi.fn(async (name: string, data: unknown) => void transport.queued.push({ queue, name, data })) };
}

export const redisModule = {
  newRedis: () => ({ subscribe: vi.fn(), on: vi.fn(), disconnect: vi.fn() }),
  redis: { publish: vi.fn(), disconnect: vi.fn() },
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
