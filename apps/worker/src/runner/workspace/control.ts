import net from "node:net";
import { chmod, rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { CanUseTool, SDKMessage, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { ndjson, type PermissionReply, type RunnerToWorker, type RunSpec, type ToolReply, type WorkerToRunner } from "@wfos/runner/protocol";

/** Minimal async queue of SDK messages coming from the sandbox. */
class MessageQueue implements AsyncIterable<SDKMessage> {
  private items: SDKMessage[] = [];
  private waiters: ((r: IteratorResult<SDKMessage>) => void)[] = [];
  private done = false;
  error: Error | null = null;

  push(m: SDKMessage) {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }
  close(error?: Error) {
    if (this.done) return;
    this.done = true;
    if (error) this.error = error;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export interface ControlOptions {
  socketPath: string;
  runToken: string;
  spec: RunSpec;
  canUseTool: CanUseTool;
  tools: SdkMcpToolDefinition[];
  signal: AbortSignal;
  onLog?: (level: string, msg: string) => void;
}

export interface Control {
  messages: MessageQueue;
  /** resolves when the runner connected and authenticated */
  connected: Promise<void>;
  abort(reason: string): void;
  close(): Promise<void>;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The narrow channel between worker and sandbox: one authenticated connection per run. The runner can only
 * ask (permission, platform tool call) and report (SDK messages, logs); every decision is made here.
 */
export async function startControl(o: ControlOptions): Promise<Control> {
  const messages = new MessageQueue();
  let session: net.Socket | null = null;
  let resolveConnected!: () => void;
  const connected = new Promise<void>((r) => (resolveConnected = r));
  const send = (s: net.Socket, m: WorkerToRunner) => s.write(`${JSON.stringify(m)}\n`);

  const server = net.createServer((sock) => {
    let authed = false;
    sock.on(
      "data",
      ndjson<RunnerToWorker>(async (m) => {
        if (!authed) {
          if (m.t !== "hello" || session || !sameToken(m.token, o.runToken)) {
            o.onLog?.("error", "control: rejected connection without a valid run token");
            sock.destroy();
            return;
          }
          authed = true;
          session = sock;
          resolveConnected();
          send(sock, { t: "start", spec: o.spec });
          return;
        }
        switch (m.t) {
          case "sdk":
            messages.push(m.m as SDKMessage);
            break;
          case "perm": {
            let result: PermissionReply;
            try {
              const r = (await o.canUseTool(m.tool, m.input, { signal: o.signal, toolUseID: m.toolUseId ?? "", suggestions: [] } as never)) as
                | { behavior: "allow"; updatedInput?: Record<string, unknown> }
                | { behavior: "deny"; message: string }
                | null;
              result = !r
                ? { behavior: "deny", message: "no permission decision" }
                : r.behavior === "allow"
                  ? { behavior: "allow", updatedInput: r.updatedInput }
                  : { behavior: "deny", message: r.message };
            } catch (e) {
              result = { behavior: "deny", message: `permission check failed: ${(e as Error).message}` };
            }
            send(sock, { t: "perm_result", id: m.id, result });
            break;
          }
          case "call": {
            const def = o.tools.find((d) => d.name === m.tool);
            let result: ToolReply;
            if (!def) result = { content: [{ type: "text", text: `Unknown platform tool ${m.tool}` }], isError: true };
            else {
              try {
                result = (await def.handler(m.args as never, {})) as ToolReply;
              } catch (e) {
                result = { content: [{ type: "text", text: `Tool ${m.tool} failed: ${(e as Error).message}` }], isError: true };
              }
            }
            send(sock, { t: "call_result", id: m.id, result });
            break;
          }
          case "log":
            o.onLog?.(m.level, m.msg);
            break;
          case "end":
            messages.close(m.error ? new Error(m.error) : undefined);
            break;
        }
      }),
    );
    sock.on("close", () => {
      if (sock === session) messages.close();
    });
    sock.on("error", () => {});
  });

  await rm(o.socketPath, { force: true });
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(o.socketPath, () => r());
  });
  await chmod(o.socketPath, 0o666);

  return {
    messages,
    connected,
    abort: (reason) => {
      if (session) send(session, { t: "abort", reason });
    },
    close: async () => {
      session?.destroy();
      await new Promise((r) => server.close(r));
      messages.close();
    },
  };
}
