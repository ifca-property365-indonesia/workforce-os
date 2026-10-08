import type { CanUseTool, PermissionResult, Query, SDKMessage, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./sdk";
import { toolDefsOf } from "../tools/registry";

/**
 * Scripted stand-in for the Agent SDK's query(). It never touches the network: each step either
 * emits a model turn with fixed token usage, asks canUseTool for a tool call (and runs platform
 * tool handlers when allowed), waits (honouring abort), or finishes with a result.
 */
export type MockStep =
  | { llm: { input: number; output: number; text?: string; model?: string } }
  | { tool: string; input: Record<string, unknown> }
  | { wait: number }
  | { result: string }
  /** emit a raw SDK message (e.g. a recorded rate_limit_event) */
  | { event: Record<string, unknown> };

export interface MockToolCall {
  name: string;
  input: Record<string, unknown>;
  permission: PermissionResult;
  output?: string;
}

export interface MockRunner {
  query: QueryFn;
  calls: MockToolCall[];
  started: number;
  /** options of the most recent query() call (env, cwd, tools…) */
  lastOptions?: NonNullable<Parameters<QueryFn>[0]["options"]>;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    }, { once: true });
  });
}

export function mockRunner(script: MockStep[]): MockRunner {
  const runner: MockRunner = { calls: [], started: 0, query: undefined as unknown as QueryFn };
  runner.query = ((params: Parameters<QueryFn>[0]) => {
    runner.started++;
    const options = params.options ?? {};
    runner.lastOptions = options;
    const signal = options.abortController?.signal;
    const canUseTool = options.canUseTool as CanUseTool | undefined;
    let n = 0;
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const step of script) {
        aborted(signal);
        if ("llm" in step) {
          n++;
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            uuid: `mock-${n}`,
            session_id: "mock-session",
            message: {
              id: `msg_mock_${n}`,
              model: step.llm.model ?? "claude-sonnet-5-5",
              role: "assistant",
              type: "message",
              content: step.llm.text ? [{ type: "text", text: step.llm.text }] : [],
              stop_reason: "end_turn",
              usage: { input_tokens: step.llm.input, output_tokens: step.llm.output },
            },
          } as unknown as SDKMessage;
        } else if ("tool" in step) {
          const permission: PermissionResult = (canUseTool
            ? await canUseTool(step.tool, step.input, { signal: signal ?? new AbortController().signal, toolUseID: `toolu_${n}` } as never)
            : null) ?? { behavior: "deny", message: "no permission decision" };
          const call: MockToolCall = { name: step.tool, input: step.input, permission };
          runner.calls.push(call);
          const [, server, toolName] = step.tool.split("__");
          if (permission.behavior === "allow" && server && toolName) {
            const cfg = (options.mcpServers as Record<string, unknown> | undefined)?.[server];
            const def = cfg ? toolDefsOf(cfg)?.find((d: SdkMcpToolDefinition) => d.name === toolName) : undefined;
            if (def) {
              const r = await def.handler((permission.updatedInput ?? step.input) as never, {});
              call.output = r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
            }
          }
          yield { type: "user", parent_tool_use_id: null, session_id: "mock-session", message: { role: "user", content: [] } } as unknown as SDKMessage;
        } else if ("event" in step) {
          yield step.event as unknown as SDKMessage;
        } else if ("wait" in step) {
          await sleep(step.wait, signal);
        } else {
          yield { type: "result", subtype: "success", result: step.result, session_id: "mock-session" } as unknown as SDKMessage;
        }
      }
    }
    return gen() as unknown as Query;
  }) as QueryFn;
  return runner;
}
