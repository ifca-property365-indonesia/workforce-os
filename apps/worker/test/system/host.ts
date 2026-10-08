import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxHost } from "../../src/runner/workspace/layout";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../../..");

function claudeDir(): string {
  const pnpm = path.join(REPO_ROOT, "node_modules/.pnpm");
  const d = readdirSync(pnpm).find((x) => x.startsWith("@anthropic-ai+claude-agent-sdk-linux-x64@"));
  if (!d) throw new Error("native Claude Code package not installed");
  return path.join(pnpm, d, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64");
}

export function testHost(): SandboxHost {
  return {
    stateBase: "/var/lib",
    runtimeDir: `/run/wfos-test-${process.pid}`,
    nodePrefix: path.dirname(path.dirname(process.execPath)),
    runnerDir: path.join(REPO_ROOT, "packages/runner/dist"),
    claudeDir: claudeDir(),
  };
}

/** Remove only what a test created: its own workspace UUID under the wfos state dirs, and its runtime dir. */
export async function cleanupWorkspace(host: SandboxHost, workspaceId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error("refusing to clean up a non-UUID path");
  await rm(path.join(host.stateBase, "private/wfos/ws", workspaceId), { recursive: true, force: true });
  await rm(path.join(host.stateBase, "wfos/ws", workspaceId), { recursive: true, force: true });
  await rm(host.runtimeDir, { recursive: true, force: true });
}
