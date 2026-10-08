import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { startGateway, type GatewayOptions } from "./gateway";
import { defaultSandboxHost, runLayout, SANDBOX, type SandboxHost } from "./layout";
import { prepareWorkspaceDirs } from "./query";
import { DEFAULT_LIMITS, launchUnit, stopUnit, type ExtraBind } from "./unit";

export interface SandboxCommandResult {
  exitCode: number | null;
  /** combined stdout+stderr as text (capped) */
  output: string;
  /** raw stdout bytes (only with rawStdout) */
  stdout: Buffer;
  truncated: boolean;
  timedOut: boolean;
}
export type ApprovedCommandResult = SandboxCommandResult;

const MAX_OUTPUT = 64 * 1024;
const MAX_RAW = 200 * 1024 * 1024;

export interface SandboxCommand {
  workspaceId: string;
  taskId: string;
  command: string;
  egressAllow: string[];
  host?: SandboxHost;
  timeoutSec?: number;
  extraBinds?: ExtraBind[];
  /** keep stdout as bytes (e.g. a git bundle) instead of text */
  rawStdout?: boolean;
  /** tests only */
  gateway?: Pick<GatewayOptions, "resolve" | "isBlocked" | "connectPort" | "onEvent">;
}

/**
 * Run a shell command in the task's workspace, in a fresh unit with the same isolation as the agent
 * (same dynamic UID, no host network, egress only through the allow-list proxy, git hooks disabled).
 * No Claude credential is involved: the API socket refuses everything.
 */
export async function runInSandbox(o: SandboxCommand): Promise<SandboxCommandResult> {
  const host = o.host ?? defaultSandboxHost();
  const layout = runLayout(host, { runId: randomUUID(), workspaceId: o.workspaceId, taskId: o.taskId });
  await prepareWorkspaceDirs(layout);
  await mkdir(layout.hostSocketDir, { recursive: true, mode: 0o755 });
  const gateway = await startGateway({
    socketDir: layout.hostSocketDir,
    runToken: randomBytes(24).toString("base64url"),
    credential: { type: "oauth", secret: "", source: "workspace" },
    egressAllow: o.egressAllow,
    upstream: "http://127.0.0.1:9", // never used: no run token is handed to the command
    ...o.gateway,
  });
  const timeout = o.timeoutSec ?? 600;
  let output = "";
  let truncated = false;
  const raw: Buffer[] = [];
  let rawSize = 0;
  const appendText = (d: Buffer) => {
    if (output.length >= MAX_OUTPUT) {
      truncated = true;
      return;
    }
    output += d.toString();
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT);
      truncated = true;
    }
  };
  try {
    const child = launchUnit({
      host,
      layout,
      limits: { ...DEFAULT_LIMITS, runtimeMaxSec: timeout },
      env: { HOME: layout.sandboxHomeDir, PATH: `${SANDBOX.nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`, WFOS_EXEC_COMMAND: o.command },
      command: [...SANDBOX.startCommand],
      extraBinds: o.extraBinds,
    });
    child.stdout?.on("data", (d: Buffer) => {
      if (!o.rawStdout) return appendText(d);
      rawSize += d.length;
      if (rawSize <= MAX_RAW) raw.push(d);
      else truncated = true;
    });
    child.stderr?.on("data", appendText);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopUnit(layout.unitName);
    }, (timeout + 15) * 1000);
    const exitCode = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    clearTimeout(timer);
    return { exitCode, output, stdout: Buffer.concat(raw), truncated, timedOut };
  } finally {
    await stopUnit(layout.unitName);
    await gateway.close();
    await rm(layout.hostSocketDir, { recursive: true, force: true });
  }
}

/** Run exactly the command a human approved (Workspace-mode Bash approval). */
export function runApprovedCommand(o: Omit<SandboxCommand, "rawStdout" | "extraBinds">): Promise<ApprovedCommandResult> {
  return runInSandbox(o);
}
