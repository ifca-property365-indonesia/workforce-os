import "server-only";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import {
  QUEUE_ACTIONS,
  QUEUE_DEPLOYS,
  QUEUE_INGEST,
  QUEUE_MISC,
  QUEUE_RUNS,
  channelFor,
  controlChannel,
  type ActionJob,
  type DeployJob,
  type IngestJob,
  type MiscJob,
  type RealtimeEvent,
  type RunJob,
} from "@wfos/shared";
import { queuePrefix } from "@wfos/shared/runtime";
import { serverEnv } from "./env";
import { regenJobId } from "./job-ids";

const g = globalThis as unknown as {
  __wfosRedis?: Redis;
  __wfosQueues?: { runs: Queue<RunJob>; actions: Queue<ActionJob>; ingest: Queue<IngestJob>; misc: Queue<MiscJob>; deploys: Queue<DeployJob> };
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
      // a deploy is never retried by the queue: a half-run pipeline is resolved by the worker (rollback), then a
      // person decides whether to deploy again
      deploys: new Queue<DeployJob>(QUEUE_DEPLOYS, { connection, prefix, defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 1000 } }),
    };
  }
  return g.__wfosQueues;
}

export const q = {
  task: (taskId: string, workspaceId: string, resumeNote?: string) =>
    queues().runs.add("task", { kind: "task", taskId, workspaceId, resumeNote }, { jobId: `task-${taskId}-${Date.now()}` }),
  chat: (conversationId: string, messageId: string, workspaceId: string) => queues().runs.add("chat", { kind: "chat", conversationId, messageId, workspaceId }),
  /** answer `userMessageId` again: the worker writes a new reply beside the existing one(s) */
  chatRegenerate: (conversationId: string, userMessageId: string, workspaceId: string) =>
    queues().runs.add("chat_regenerate", { kind: "chat_regenerate", conversationId, userMessageId, workspaceId }, { jobId: regenJobId(userMessageId) }),
  action: (job: ActionJob) => queues().actions.add(job.kind, job, { jobId: `${job.kind}-${job.approvalId}` }),
  ingest: (documentId: string, workspaceId: string) => queues().ingest.add("ingest", { kind: "ingest", documentId, workspaceId }),
  misc: (job: MiscJob) => queues().misc.add(job.kind, job),
  /** a release runs as job <releaseId>; an app action as app-<id>-<action>-<ts> */
  deploy: (job: DeployJob) =>
    queues().deploys.add(job.kind, job, { jobId: job.kind === "release" ? job.releaseId : `app-${job.appId}-${job.action}-${Date.now()}` }),
};

export async function publish(workspaceId: string, ev: RealtimeEvent) {
  await redis().publish(channelFor(workspaceId, serverEnv.namespace), JSON.stringify(ev));
}

/** Control channel: kill switch, task cancellation, and stopping a conversation's in-flight reply (an edit forked it). */
export type ControlMessage =
  | { type: "kill"; workspaceId: string }
  | { type: "cancel_task"; taskId: string }
  | { type: "abort_conversation"; conversationId: string };

export async function control(msg: ControlMessage) {
  await redis().publish(controlChannel(serverEnv.namespace), JSON.stringify(msg));
}
