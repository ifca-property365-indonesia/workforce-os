/**
 * Runs INSIDE a Workspace-mode sandbox (per-run systemd unit: own UID, own network namespace, read-only system).
 *
 * - Bridges the sandbox's own loopback to the two gateway sockets bound into the unit:
 *     127.0.0.1:apiPort   → api.sock    (Anthropic API; the gateway swaps the per-run dummy token for the real credential)
 *     127.0.0.1:proxyPort → egress.sock (HTTP CONNECT proxy with the per-employee domain allow-list)
 * - Talks to the worker over control.sock (NDJSON): receives the run spec, asks it for every tool permission,
 *   forwards platform tool calls to it, and streams every SDK message back.
 *
 * It holds no platform secret and no real Claude credential.
 */
import net from "node:net";
import { z } from "zod";
import { createSdkMcpServer, query, tool, type PermissionResult, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { SANDBOX, ndjson, type PermissionReply, type RunnerToWorker, type RunSpec, type ToolReply, type WorkerToRunner } from "./protocol";

const runToken = process.env.WFOS_RUN_TOKEN ?? "";
const socketDir = process.env.WFOS_SOCKET_DIR ?? SANDBOX.socketDir;

function bridge(port: number, socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(socketPath);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Exec mode: run exactly one human-approved command in the workspace (same sandbox, same egress proxy),
 * with git hooks and repository-defined git config neutralised. Output goes to stdout/stderr.
 */
async function execApproved(command: string): Promise<number> {
  const { spawn } = await import("node:child_process");
  const proxyPort = Number(process.env.WFOS_PROXY_PORT ?? SANDBOX.proxyPort);
  const b = await bridge(proxyPort, `${socketDir}/egress.sock`);
  const proxy = `http://127.0.0.1:${proxyPort}`;
  const code = await new Promise<number>((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: "C.UTF-8",
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
        NO_PROXY: "127.0.0.1,localhost",
        NODE_USE_ENV_PROXY: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/mnt/wfos/runner/gitconfig",
        GIT_CONFIG_NOSYSTEM: "1",
        // hooks never run for platform-executed commands, whatever the repo or command configures
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
        // the platform's read-only mirror is owned by root; trust exactly that path
        GIT_CONFIG_KEY_2: "safe.directory",
        GIT_CONFIG_VALUE_2: "/mnt/wfos/upstream.git",
      },
    });
    child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : 1)));
    child.on("error", () => resolve(127));
  });
  b.close();
  return code;
}

async function main(): Promise<void> {
  if (process.env.WFOS_EXEC_COMMAND !== undefined) {
    process.exit(await execApproved(process.env.WFOS_EXEC_COMMAND));
  }
  const apiPort = Number(process.env.WFOS_API_PORT ?? SANDBOX.apiPort);
  const proxyPort = Number(process.env.WFOS_PROXY_PORT ?? SANDBOX.proxyPort);
  const bridges = await Promise.all([bridge(apiPort, `${socketDir}/api.sock`), bridge(proxyPort, `${socketDir}/egress.sock`)]);

  const control = net.connect(`${socketDir}/control.sock`);
  await new Promise<void>((resolve, reject) => {
    control.once("connect", resolve);
    control.once("error", reject);
  });
  const send = (m: RunnerToWorker) => control.write(`${JSON.stringify(m)}\n`);

  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  const abort = new AbortController();
  const started = new Promise<RunSpec>((resolve) => {
    control.on(
      "data",
      ndjson<WorkerToRunner>((m) => {
        if (m.t === "start") resolve(m.spec);
        else if (m.t === "perm_result" || m.t === "call_result") {
          pending.get(m.id)?.(m.result);
          pending.delete(m.id);
        } else if (m.t === "abort") abort.abort(new Error(m.reason));
      }),
    );
  });
  control.on("close", () => abort.abort(new Error("control channel closed")));
  const rpc = <T>(m: RunnerToWorker & { id: number }): Promise<T> =>
    new Promise<T>((resolve) => {
      pending.set(m.id, resolve as (v: unknown) => void);
      send(m);
    });

  send({ t: "hello", token: runToken, pid: process.pid });
  const s = await started;

  // Platform tools: same names and schemas as in the worker; every call is executed (and gated) by the worker.
  const defs = s.mcpTools.map((t) => {
    const schema = z.fromJSONSchema(t.inputSchema as never) as unknown as { shape?: z.ZodRawShape };
    return tool(t.name, t.description, schema.shape ?? {}, async (args: Record<string, unknown>) => rpc<ToolReply>({ t: "call", id: nextId++, tool: t.name, args }));
  }) as unknown as SdkMcpToolDefinition[];
  const mcp = createSdkMcpServer({ name: s.mcpServer, version: "0.1.0", tools: defs, alwaysLoad: true, timeout: 600_000 });

  const proxy = `http://127.0.0.1:${proxyPort}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    // the API goes through the credential gateway; the token here is a per-run dummy the gateway replaces
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
    ...(s.credentialType === "api_key" ? { ANTHROPIC_API_KEY: runToken } : { CLAUDE_CODE_OAUTH_TOKEN: runToken }),
    // everything else leaves through the allow-list proxy (the network namespace has no other way out)
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "workforce-os-runner/0.1.0",
    GIT_AUTHOR_NAME: s.gitIdentity.name,
    GIT_AUTHOR_EMAIL: s.gitIdentity.email,
    GIT_COMMITTER_NAME: s.gitIdentity.name,
    GIT_COMMITTER_EMAIL: s.gitIdentity.email,
    GIT_TERMINAL_PROMPT: "0",
  };

  let error: string | undefined;
  try {
    const q = query({
      prompt: s.prompt,
      options: {
        abortController: abort,
        model: s.model,
        systemPrompt: { type: "preset", preset: "claude_code", append: s.systemPrompt },
        cwd: process.cwd(),
        env,
        pathToClaudeCodeExecutable: process.env.WFOS_CLAUDE_BIN ?? SANDBOX.claudeBinary,
        tools: s.tools,
        mcpServers: { [s.mcpServer]: mcp },
        strictMcpConfig: true,
        // user settings = the run's HOME (skills seeded by the platform); never project settings from the repo
        settingSources: ["user"],
        permissionMode: "default",
        includePartialMessages: true,
        maxTurns: s.maxTurns,
        maxBudgetUsd: s.maxBudgetUsd,
        ...(s.resume ? { resume: s.resume } : {}),
        canUseTool: async (toolName, input, opts): Promise<PermissionResult> => {
          const r = await rpc<PermissionReply>({ t: "perm", id: nextId++, tool: toolName, input, toolUseId: (opts as { toolUseID?: string }).toolUseID });
          return r.behavior === "allow" ? { behavior: "allow", updatedInput: r.updatedInput ?? input } : { behavior: "deny", message: r.message };
        },
        stderr: (d) => send({ t: "log", level: "warn", msg: d.slice(0, 2000) }),
      },
    });
    for await (const m of q) send({ t: "sdk", m });
  } catch (e) {
    error = (e as Error).message;
  }
  send({ t: "end", error });
  for (const b of bridges) b.close();
  control.end();
  setTimeout(() => process.exit(error ? 1 : 0), 200).unref();
}

main().catch((e) => {
  process.stderr.write(`runner failed: ${(e as Error).stack ?? e}\n`);
  process.exit(2);
});
