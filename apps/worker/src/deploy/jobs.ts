import type { AppSlot, DeployJob } from "@wfos/shared";

/**
 * A job only the worker queues on the deploys queue (never the web): stop the unit that served before a live release
 * once its grace time is over (a delayed job, so it survives a worker restart; the deploys queue runs it after any
 * release or restore of the environment, never beside one). `slot` "legacy" = the single unit of a B1 environment.
 */
export type SlotStopJob = { kind: "slot_stop"; appId: string; workspaceId: string; environmentId: string; releaseId: string; slot: AppSlot | "legacy" };

/** what the deploys queue carries: the shared DeployJob kinds plus the worker's own */
export type WorkerDeployJob = DeployJob | SlotStopJob;
