import type { AppEnvironmentKind, AppManifest, ReleaseStatus, ReleaseStep, ReleaseWarning } from "@wfos/shared";

/**
 * A preview a Developer published from a task (request_preview → approval → release), as the task page shows it.
 * `url` is set only while that release is the one deployed: before (queued, deploying) or after (failed,
 * replaced) the address serves something else, so the task never links to it as "this work".
 */
export interface TaskPreview {
  id: string;
  appId: string;
  appName: string;
  /** "live": a LIVE release the task proposed (request_release, B3) */
  environmentKind: AppEnvironmentKind;
  status: ReleaseStatus;
  step: ReleaseStep | null;
  commit: string;
  commitSubject: string | null;
  warnings: ReleaseWarning[];
  error: string | null;
  approvalId: string | null;
  url: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** The task (and its employee) behind an approval-triggered release, for the app page's "by … via …". */
export interface ReleaseOrigin {
  taskId: string;
  taskTitle: string;
  employeeId: string | null;
  employeeName: string | null;
}

/**
 * What a release's manifest says about its database, for the Release to LIVE dialog: whether it has one (live then
 * takes a backup first) and how its migrations run on live ("expand": while the old version serves, no downtime;
 * "breaking": behind the maintenance page).
 */
export interface ReleaseDbPlan {
  database: boolean;
  migrations: AppManifest["migrations"];
}
