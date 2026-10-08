import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { startGateway, type GatewayOptions } from "./gateway";
import { defaultSandboxHost, runLayout, SANDBOX, type SandboxHost } from "./layout";
import { prepareWorkspaceDirs } from "./query";
import { DEFAULT_LIMITS, launchUnit, stopUnit } from "./unit";

export interface ApprovedCommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

const MAX_OUTPUT = 64 * 1024;

/**
 * Run exactly the approved command in the task's workspace, in a fresh unit with the same isolation as the
 * agent (same dynamic UID, no host network, egress only through the allow-list proxy). No Claude credential
 * is involved: the API socket refuses everything.
 */
export async function runApprovedCommand(o: {
  workspaceId: string;
  taskId: string;
  command: string;
  egressAllow: string[];
  host?: SandboxHost;
  timeoutSec?: number;
  /** tests only */
  gateway?: Pick<GatewayOptions, "resolve" | "isBlocked" | "connectPort" | "onEvent">;
}): Promise<ApprovedCommandResult> {
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
  const append = (d: Buffer) => {
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
    });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopUnit(layout.unitName);
    }, (timeout + 15) * 1000);
    const exitCode = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    clearTimeout(timer);
    return { exitCode, output, truncated, timedOut };
  } finally {
    await stopUnit(layout.unitName);
    await gateway.close();
    await rm(layout.hostSocketDir, { recursive: true, force: true });
  }
}
