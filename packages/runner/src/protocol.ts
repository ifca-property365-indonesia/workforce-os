/**
 * Wire protocol between the worker and the runner process inside a Workspace-mode sandbox.
 * Newline-delimited JSON over the per-run control Unix socket. The runner never talks to the database,
 * Redis or the network directly: everything it needs comes through this socket and the two gateway sockets.
 */

export interface McpToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool input (from zod) */
  inputSchema: Record<string, unknown>;
}

export interface RunSpec {
  prompt: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Claude Code built-ins enabled in Workspace mode */
  tools: string[];
  /** platform tools, executed by the worker */
  mcpServer: string;
  mcpTools: McpToolSpec[];
  /** resume this Claude session (follow-up on the same task) */
  resume?: string;
  /** which header the gateway will rewrite; the runner itself only holds a per-run dummy */
  credentialType: "oauth" | "api_key";
  gitIdentity: { name: string; email: string };
}

export type RunnerToWorker =
  | { t: "hello"; token: string; pid: number }
  | { t: "sdk"; m: unknown }
  | { t: "perm"; id: number; tool: string; input: Record<string, unknown>; toolUseId?: string }
  | { t: "call"; id: number; tool: string; args: Record<string, unknown> }
  | { t: "log"; level: "info" | "warn" | "error"; msg: string }
  | { t: "end"; error?: string };

export type PermissionReply = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string };
export type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

export type WorkerToRunner =
  | { t: "start"; spec: RunSpec }
  | { t: "perm_result"; id: number; result: PermissionReply }
  | { t: "call_result"; id: number; result: ToolReply }
  | { t: "abort"; reason: string };

/**
 * Paths and ports as seen from inside the sandbox. Everything platform-provided is mounted under /mnt/wfos,
 * a tmpfs private to the unit (TemporaryFileSystem=/mnt), so systemd never creates mount points on the host.
 */
export const SANDBOX = {
  mountRoot: "/mnt",
  socketDir: "/mnt/wfos/run",
  control: "/mnt/wfos/run/control.sock",
  api: "/mnt/wfos/run/api.sock",
  egress: "/mnt/wfos/run/egress.sock",
  /** the sandbox's own loopback (PrivateNetwork): bridged to the gateway sockets */
  apiPort: 47801,
  proxyPort: 47802,
  claudeBinary: "/mnt/wfos/claude/claude",
  nodeDir: "/mnt/wfos/node",
  node: "/mnt/wfos/node/bin/node",
  runner: "/mnt/wfos/runner/runner.mjs",
  /** systemd resolves ExecStart on the host, so start through /bin/sh and exec into the sandbox paths */
  startCommand: ["/bin/sh", "-c", "exec /mnt/wfos/node/bin/node /mnt/wfos/runner/runner.mjs"],
} as const;

/** Split a stream into NDJSON messages. */
export function ndjson<T>(onMessage: (m: T) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onMessage(JSON.parse(line) as T);
    }
  };
}
