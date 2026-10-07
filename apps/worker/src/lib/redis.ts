import { Redis } from "ioredis";
import { Queue } from "bullmq";
import {
  channelFor,
  QUEUE_ACTIONS,
  QUEUE_INGEST,
  QUEUE_MISC,
  QUEUE_RUNS,
  type ActionJob,
  type IngestJob,
  type MiscJob,
  type RealtimeEvent,
  type RunJob,
} from "@wfos/shared";
import { env } from "./env";

export function newRedis(): Redis {
  return new Redis(env.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export const redis = newRedis();
export const connection = { url: env.redisUrl };

const defaultJobOptions = { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 };

export const runsQueue = new Queue<RunJob>(QUEUE_RUNS, { connection, defaultJobOptions });
export const actionsQueue = new Queue<ActionJob>(QUEUE_ACTIONS, { connection, defaultJobOptions });
export const ingestQueue = new Queue<IngestJob>(QUEUE_INGEST, { connection, defaultJobOptions });
export const miscQueue = new Queue<MiscJob>(QUEUE_MISC, { connection, defaultJobOptions });

export async function publish(workspaceId: string, ev: RealtimeEvent): Promise<void> {
  await redis.publish(channelFor(workspaceId), JSON.stringify(ev));
}

export const CONTROL_CHANNEL = "wfos:control";
export type ControlMessage = { type: "kill"; workspaceId: string } | { type: "cancel_task"; taskId: string };

export async function enqueueTask(taskId: string, workspaceId: string, resumeNote?: string, delayMs = 0): Promise<void> {
  await runsQueue.add("task", { kind: "task", taskId, workspaceId, resumeNote }, { jobId: `task-${taskId}-${Date.now()}`, delay: delayMs });
}
