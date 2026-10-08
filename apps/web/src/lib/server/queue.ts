import "server-only";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import {
  QUEUE_ACTIONS,
  QUEUE_INGEST,
  QUEUE_MISC,
  QUEUE_RUNS,
  channelFor,
  controlChannel,
  type ActionJob,
  type IngestJob,
  type MiscJob,
  type RealtimeEvent,
  type RunJob,
} from "@wfos/shared";
import { queuePrefix } from "@wfos/shared/runtime";
import { serverEnv } from "./env";

const g = globalThis as unknown as {
  __wfosRedis?: Redis;
  __wfosQueues?: { runs: Queue<RunJob>; actions: Queue<ActionJob>; ingest: Queue<IngestJob>; misc: Queue<MiscJob> };
};

export function redis(): Redis {
  if (!g.__wfosRedis) g.__wfosRedis = new Redis(serverEnv.redisUrl, { maxRetriesPerRequest: 3 });
  return g.__wfosRedis;
}

function queues() {
  if (!g.__wfosQueues) {
    const connection = { url: serverEnv.redisUrl };
    const prefix = queuePrefix();
    const defaultJobOptions = { attempts: 3, backoff: { type: "exponential" as const, delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 };
    g.__wfosQueues = {
      runs: new Queue<RunJob>(QUEUE_RUNS, { connection, prefix, defaultJobOptions }),
      actions: new Queue<ActionJob>(QUEUE_ACTIONS, { connection, prefix, defaultJobOptions }),
      ingest: new Queue<IngestJob>(QUEUE_INGEST, { connection, prefix, defaultJobOptions }),
      misc: new Queue<MiscJob>(QUEUE_MISC, { connection, prefix, defaultJobOptions }),
    };
  }
  return g.__wfosQueues;
}

export const q = {
  task: (taskId: string, workspaceId: string, resumeNote?: string) =>
    queues().runs.add("task", { kind: "task", taskId, workspaceId, resumeNote }, { jobId: `task-${taskId}-${Date.now()}` }),
  chat: (conversationId: string, messageId: string, workspaceId: string) => queues().runs.add("chat", { kind: "chat", conversationId, messageId, workspaceId }),
  action: (job: ActionJob) => queues().actions.add(job.kind, job, { jobId: `${job.kind}-${job.approvalId}` }),
  ingest: (documentId: string, workspaceId: string) => queues().ingest.add("ingest", { kind: "ingest", documentId, workspaceId }),
  misc: (job: MiscJob) => queues().misc.add(job.kind, job),
};

export async function publish(workspaceId: string, ev: RealtimeEvent) {
  await redis().publish(channelFor(workspaceId, serverEnv.namespace), JSON.stringify(ev));
}

export async function control(msg: { type: "kill"; workspaceId: string } | { type: "cancel_task"; taskId: string }) {
  await redis().publish(controlChannel(serverEnv.namespace), JSON.stringify(msg));
}
