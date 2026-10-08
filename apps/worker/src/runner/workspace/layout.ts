import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX } from "@wfos/runner/protocol";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Host paths the sandbox needs (read-only binds) and where per-run state lives. Overridable for tests. */
export interface SandboxHost {
  /** systemd state base (StateDirectory= is relative to it; DynamicUser state lives in <base>/private) */
  stateBase: string;
  /** root-only runtime dir for per-run sockets */
  runtimeDir: string;
  /** Node.js installation prefix (contains bin/node) */
  nodePrefix: string;
  /** directory with the bundled runner.mjs */
  runnerDir: string;
  /** directory of the native Claude Code package (contains the `claude` binary) */
  claudeDir: string;
}

export function defaultSandboxHost(): SandboxHost {
  const nodePrefix = path.dirname(path.dirname(process.execPath));
  const repoRoot = path.resolve(here, "../../../../..");
  const pnpm = path.join(repoRoot, "node_modules/.pnpm");
  const claudePkg = process.env.WFOS_CLAUDE_DIR ?? findClaudePackage(pnpm);
  return {
    stateBase: process.env.WFOS_STATE_BASE ?? "/var/lib",
    runtimeDir: process.env.WFOS_RUNTIME_DIR ?? "/run/wfos",
    nodePrefix: process.env.WFOS_NODE_PREFIX ?? nodePrefix,
    runnerDir: process.env.WFOS_RUNNER_DIR ?? path.join(repoRoot, "packages/runner/dist"),
    claudeDir: claudePkg,
  };
}

function findClaudePackage(pnpmDir: string): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const want = `@anthropic-ai+claude-agent-sdk-linux-${arch}@`;
  try {
    const dir = readdirSync(pnpmDir).find((d) => d.startsWith(want));
    if (dir) {
      const p = path.join(pnpmDir, dir, "node_modules/@anthropic-ai", `claude-agent-sdk-linux-${arch}`);
      if (existsSync(path.join(p, "claude"))) return p;
    }
  } catch {
    // fall through
  }
  return "/opt/wfos/claude";
}

export interface RunLayout {
  runId: string;
  workspaceId: string;
  taskId: string;
  unitName: string;
  /** stable per task, so the same task always runs as the same dynamic UID (no re-chown of the repo) */
  userName: string;
  /** relative StateDirectory: one workspace per task, kept across follow-up runs */
  stateRel: string;
  /** host path of the state directory (DynamicUser keeps it under <base>/private) */
  hostStateDir: string;
  /** the same directory as the sandbox sees it */
  sandboxStateDir: string;
  sandboxRepoDir: string;
  sandboxHomeDir: string;
  /** host dir with control.sock, api.sock, egress.sock (bound to /run/wfos-run inside) */
  hostSocketDir: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runLayout(host: SandboxHost, ids: { runId: string; workspaceId: string; taskId: string }): RunLayout {
  for (const [k, v] of Object.entries(ids)) if (!UUID.test(v)) throw new Error(`${k} must be a UUID`);
  const stateRel = `wfos/ws/${ids.workspaceId}/${ids.taskId}`;
  const sandboxStateDir = path.posix.join(host.stateBase, stateRel);
  return {
    ...ids,
    unitName: `wfos-run-${ids.runId}`,
    userName: `wfos-${createHash("sha256").update(ids.taskId).digest("hex").slice(0, 20)}`,
    stateRel,
    hostStateDir: path.join(host.stateBase, "private", stateRel),
    sandboxStateDir,
    sandboxRepoDir: `${sandboxStateDir}/repo`,
    sandboxHomeDir: `${sandboxStateDir}/home`,
    hostSocketDir: path.join(host.runtimeDir, "runs", ids.runId),
  };
}

export { SANDBOX };
