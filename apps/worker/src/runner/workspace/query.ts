import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Options, Query, SDKMessage, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { WORKSPACE_BUILTIN_TOOLS } from "@wfos/shared";
import type { ClaudeCredential } from "@wfos/db/claude";
import type { RunSpec } from "@wfos/runner/protocol";
import { toolDefsOf } from "../../tools/registry";
import type { QueryFn } from "../sdk";
import { log } from "../../lib/logger";
import { startControl } from "./control";
import { startGateway, type GatewayEvent } from "./gateway";
import { defaultSandboxHost, runLayout, SANDBOX, type RunLayout, type SandboxHost } from "./layout";
import { DEFAULT_LIMITS, launchUnit, stopUnit, type UnitLimits } from "./unit";

export interface WorkspaceRunConfig {
  workspaceId: string;
  taskId: string;
  credential: ClaudeCredential;
  egressAllow: string[];
  gitIdentity: { name: string; email: string };
  host?: SandboxHost;
  limits?: UnitLimits;
  /** Anthropic API base for the gateway (tests: a local stub) */
  upstream?: string;
  onGatewayEvent?: (e: GatewayEvent) => void;
  onLayout?: (l: RunLayout) => void;
}

/** Host-side preparation of the per-task workspace before the unit starts (runs as root, before chown). */
export async function prepareWorkspaceDirs(layout: RunLayout): Promise<void> {
  await mkdir(path.join(layout.hostStateDir, "repo"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(layout.hostStateDir, "home", ".claude"), { recursive: true, mode: 0o700 });
}

export async function workspaceExists(layout: RunLayout): Promise<boolean> {
  return stat(layout.hostStateDir).then(
    () => true,
    () => false,
  );
}

function toolSpecs(defs: SdkMcpToolDefinition[]) {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: z.toJSONSchema(z.object(d.inputSchema as z.ZodRawShape)) as Record<string, unknown>,
  }));
}

/**
 * A query() with the same contract as the Agent SDK's, but the agent runs in an isolated per-run systemd unit.
 * Everything that needs the platform (permissions, platform tools, accounting) stays in this process.
 */
export function createWorkspaceQuery(cfg: WorkspaceRunConfig): QueryFn {
  return ((params: { prompt: string; options?: Options }) => run(cfg, params) as unknown as Query) as unknown as QueryFn;
}

async function* run(cfg: WorkspaceRunConfig, params: { prompt: string; options?: Options }): AsyncGenerator<SDKMessage> {
  const o = params.options ?? {};
  const host = cfg.host ?? defaultSandboxHost();
  const layout = runLayout(host, { runId: randomUUID(), workspaceId: cfg.workspaceId, taskId: cfg.taskId });
  cfg.onLayout?.(layout);
  if (!o.canUseTool) throw new Error("Workspace mode needs a permission callback");
  const server = Object.values((o.mcpServers ?? {}) as Record<string, unknown>)[0];
  const defs = toolDefsOf(server) ?? [];
  const mcpServer = Object.keys((o.mcpServers ?? {}) as Record<string, unknown>)[0] ?? "wfos";
  const runToken = `wfos-run-${randomBytes(24).toString("base64url")}`;
  const abort = o.abortController ?? new AbortController();

  const spec: RunSpec = {
    prompt: params.prompt,
    systemPrompt: typeof o.systemPrompt === "string" ? o.systemPrompt : "",
    model: o.model ?? "claude-sonnet-5-5",
    maxTurns: o.maxTurns ?? 50,
    maxBudgetUsd: o.maxBudgetUsd ?? 1,
    tools: [...WORKSPACE_BUILTIN_TOOLS],
    mcpServer,
    mcpTools: toolSpecs(defs),
    resume: o.resume,
    credentialType: cfg.credential.type,
    gitIdentity: cfg.gitIdentity,
  };

  await prepareWorkspaceDirs(layout);
  await mkdir(layout.hostSocketDir, { recursive: true, mode: 0o755 });
  const gateway = await startGateway({
    socketDir: layout.hostSocketDir,
    runToken,
    credential: cfg.credential,
    egressAllow: cfg.egressAllow,
    upstream: cfg.upstream,
    onEvent: cfg.onGatewayEvent,
  });
  const control = await startControl({
    socketPath: `${layout.hostSocketDir}/control.sock`,
    runToken,
    spec,
    canUseTool: o.canUseTool,
    tools: defs,
    signal: abort.signal,
    onLog: (level, msg) => log.debug({ unit: layout.unitName, level, msg: msg.slice(0, 500) }, "runner"),
  });

  let stderr = "";
  const child = launchUnit({
    host,
    layout,
    limits: cfg.limits ?? DEFAULT_LIMITS,
    env: { WFOS_RUN_TOKEN: runToken, HOME: layout.sandboxHomeDir, PATH: `${SANDBOX.nodeDir}/bin:/usr/local/bin:/usr/bin:/bin` },
    command: [...SANDBOX.startCommand],
  });
  child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  void exited.then(() => control.messages.close());

  const onAbort = () => {
    control.abort(String((abort.signal.reason as Error | undefined)?.message ?? "aborted"));
    void stopUnit(layout.unitName);
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const m of control.messages) yield m;
    if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error("aborted");
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
    if (control.messages.error) throw control.messages.error;
    if (code !== 0 && code !== null) throw new Error(`sandbox exited with code ${code}: ${stderr.trim().slice(-800) || "no output"}`);
  } finally {
    abort.signal.removeEventListener("abort", onAbort);
    await stopUnit(layout.unitName);
    await control.close();
    await gateway.close();
    await rm(layout.hostSocketDir, { recursive: true, force: true });
  }
}
