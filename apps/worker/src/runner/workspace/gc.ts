import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import { db, tasks } from "@wfos/db";
import { log } from "../../lib/logger";
import { defaultSandboxHost, runLayout, type SandboxHost } from "./layout";

const exec = promisify(execFile);

export function retentionDays(): number {
  return Math.max(0, Number(process.env.WORKSPACE_RETENTION_DAYS ?? 14));
}

/**
 * Remove task workspaces (the checked-out repo, build output, the Claude session files) after the retention
 * period, or right away when the task was discarded. Deliverables, diffs and bundles stay on the task.
 * fs.rm never follows symlinks, so links the agent left inside its workspace cannot redirect the delete.
 */
export async function collectWorkspaces(o: { now?: Date; host?: SandboxHost } = {}): Promise<number> {
  const now = o.now ?? new Date();
  const host = o.host ?? defaultSandboxHost();
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const rows = await db
    .select({ id: tasks.id, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(
      or(
        eq(tasks.workspaceStatus, "discarded"),
        and(eq(tasks.workspaceStatus, "active"), inArray(tasks.status, ["DONE", "FAILED", "CANCELLED"]), isNotNull(tasks.completedAt), lt(tasks.completedAt, cutoff)),
      ),
    )
    .limit(200);
  let n = 0;
  for (const r of rows) {
    const layout = runLayout(host, { runId: r.id, workspaceId: r.workspaceId, taskId: r.id });
    try {
      await rm(layout.hostStateDir, { recursive: true, force: true });
      // the /var/lib/<rel> symlink systemd keeps for DynamicUser state
      await rm(`${host.stateBase}/${layout.stateRel}`, { force: true, recursive: false }).catch(() => {});
      await db.update(tasks).set({ workspaceStatus: "archived" }).where(eq(tasks.id, r.id));
      n++;
    } catch (e) {
      log.warn({ err: e, taskId: r.id }, "workspace cleanup failed");
    }
  }
  return n;
}

let available: Promise<boolean> | null = null;

/** Workspace mode needs root and systemd (the native install). Docker and dev setups without them fail closed. */
export function sandboxAvailable(): Promise<boolean> {
  if (!available) {
    available =
      process.getuid?.() !== 0
        ? Promise.resolve(false)
        : exec("systemd-run", ["--version"], { timeout: 5000 }).then(
            () => true,
            () => false,
          );
  }
  return available;
}
