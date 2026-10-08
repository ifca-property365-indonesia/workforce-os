import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_STALE_MS, heartbeatKey, type WorkerHeartbeat } from "@wfos/shared/ops";
import { activeRunCount } from "../guards/killswitch";
import { defaultSandboxHost } from "../runner/workspace/layout";
import { sandboxAvailable } from "../runner/workspace/gc";
import { env } from "./env";
import { redis } from "./redis";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
let commit: string | null | undefined;
function currentCommit(): string | null {
  if (commit === undefined) {
    try {
      commit = process.env.WFOS_COMMIT || execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 3000 }).trim();
    } catch {
      commit = null;
    }
  }
  return commit;
}

/** What /api/health shows about this worker: alive, which commit, and whether Workspace-mode runs can start. */
export async function heartbeat(): Promise<WorkerHeartbeat> {
  const host = defaultSandboxHost();
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    commit: currentCommit(),
    activeRuns: activeRunCount(),
    sandbox: {
      available: await sandboxAvailable(),
      runner: existsSync(path.join(host.runnerDir, "runner.mjs")),
      claude: existsSync(path.join(host.claudeDir, "claude")),
    },
  };
}

export async function writeHeartbeat(): Promise<void> {
  await redis.set(heartbeatKey(env.namespace), JSON.stringify(await heartbeat()), "PX", HEARTBEAT_STALE_MS);
}
