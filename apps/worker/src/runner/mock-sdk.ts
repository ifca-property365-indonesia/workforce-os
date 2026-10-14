import type { CanUseTool, HookCallbackMatcher, HookJSONOutput, PermissionResult, Query, SDKMessage, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./sdk";
import { toolDefsOf } from "../tools/registry";

/**
 * Scripted stand-in for the Agent SDK's query(). It never touches the network: each step either
 * emits a model turn with fixed token usage, asks canUseTool for a tool call (and runs platform
 * tool handlers when allowed), waits (honouring abort), or finishes with a result. Allowed tool calls that
 * produced a result go through the configured PostToolUse hooks, whose updatedMCPToolOutput / updatedToolOutput
 * replaces what the model would see (MockToolCall.output); allowed calls that failed go through the
 * PostToolUseFailure hooks (with `error`), whose additionalContext is kept on MockToolCall.failureContext.
 */
export type MockStep =
  | { llm: { input: number; output: number; text?: string; model?: string } }
  /**
   * `error`: an allowed call to an external MCP tool (no handler here) returns an error result (its text is
   * `output`, default "external tool failed");
   * `output`: the text an allowed external MCP tool returns (default "ok");
   * `durationMs`: how long an allowed call runs before its result (no SDK event meanwhile; honours abort)
   */
  /**
   * `parentToolUseId`: the call is made by the subagent started by that Task tool_use (canUseTool gets `agentID`, the
   * assistant tool_use and its result carry parent_tool_use_id); `toolUseId`: a fixed id for the call
   */
  | { tool: string; input: Record<string, unknown>; error?: boolean; output?: string; durationMs?: number; parentToolUseId?: string; toolUseId?: string }
  | { wait: number }
  | { result: string }
  /** emit a raw SDK message (e.g. a recorded rate_limit_event) */
  | { event: Record<string, unknown> };

export interface MockToolCall {
  name: string;
  input: Record<string, unknown>;
  permission: PermissionResult;
  output?: string;
  /** additionalContext returned by a PostToolUseFailure hook */
  failureContext?: string;
}

export interface MockRunner {
  query: QueryFn;
  calls: MockToolCall[];
  started: number;
  /** options of the most recent query() call (env, cwd, tools…) */
  lastOptions?: NonNullable<Parameters<QueryFn>[0]["options"]>;
  /** the prompt of the most recent query() call, when it was a string */
  lastPrompt?: string;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** MCP-style content blocks → text (what a PostToolUse rewrite hands back). */
function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => (typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).join("\n");
  return JSON.stringify(v);
}

function matching(matchers: HookCallbackMatcher[] | undefined, name: string): HookCallbackMatcher[] {
  return (matchers ?? []).filter((m) => !m.matcher || m.matcher === "*" || new RegExp(`^(?:${m.matcher})$`).test(name));
}

/** Run the PostToolUse hooks whose matcher (Claude Code semantics: a regex over the tool name; none = all) fits. */
async function postToolUse(
  matchers: HookCallbackMatcher[] | undefined,
  name: string,
  toolInput: Record<string, unknown>,
  response: unknown,
  toolUseId: string,
  signal: AbortSignal,
): Promise<unknown> {
  let current = response;
  for (const m of matching(matchers, name)) {
    for (const hook of m.hooks) {
      const out = (await hook(
        {
          hook_event_name: "PostToolUse",
          session_id: "mock-session",
          transcript_path: "",
          cwd: "",
          tool_name: name,
          tool_input: toolInput,
          tool_response: response,
          tool_use_id: toolUseId,
        },
        toolUseId,
        { signal },
      )) as HookJSONOutput;
      const specific = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
      if (specific?.hookEventName !== "PostToolUse") continue;
      if (specific.updatedMCPToolOutput !== undefined && name.startsWith("mcp__")) current = specific.updatedMCPToolOutput;
      else if (specific.updatedToolOutput !== undefined) current = specific.updatedToolOutput;
    }
  }
  return current;
}

/** Run the PostToolUseFailure hooks; returns their additionalContext (joined), if any. */
async function postToolUseFailure(
  matchers: HookCallbackMatcher[] | undefined,
  name: string,
  toolInput: Record<string, unknown>,
  error: string,
  toolUseId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const context: string[] = [];
  for (const m of matching(matchers, name)) {
    for (const hook of m.hooks) {
      const out = (await hook(
        { hook_event_name: "PostToolUseFailure", session_id: "mock-session", transcript_path: "", cwd: "", tool_name: name, tool_input: toolInput, tool_use_id: toolUseId, error },
        toolUseId,
        { signal },
      )) as HookJSONOutput;
      const specific = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
      if (specific?.hookEventName === "PostToolUseFailure" && specific.additionalContext) context.push(specific.additionalContext);
    }
  }
  return context.length ? context.join("\n") : undefined;
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
    runner.lastPrompt = typeof params.prompt === "string" ? params.prompt : undefined;
    const signal = options.abortController?.signal;
    const canUseTool = options.canUseTool as CanUseTool | undefined;
    let n = 0;
    let toolN = 0;
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
          const toolUseId = step.toolUseId ?? `toolu_mock_${++toolN}`;
          const parent = step.parentToolUseId ?? null;
          let isError = false;
          let resultText = "ok";
          if (parent) {
            // a subagent's call: its assistant message comes first, as in the SDK stream
            n++;
            yield {
              type: "assistant",
              parent_tool_use_id: parent,
              uuid: `mock-${n}`,
              session_id: "mock-session",
              message: { id: `msg_mock_${n}`, model: "claude-sonnet-5-5", role: "assistant", type: "message", content: [{ type: "tool_use", id: toolUseId, name: step.tool, input: step.input }], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
            } as unknown as SDKMessage;
          }
          const permission: PermissionResult = (canUseTool
            ? await canUseTool(step.tool, step.input, { signal: signal ?? new AbortController().signal, toolUseID: toolUseId, ...(parent ? { agentID: `agent-${parent}` } : {}) } as never)
            : null) ?? { behavior: "deny", message: "no permission decision" };
          const call: MockToolCall = { name: step.tool, input: step.input, permission };
          runner.calls.push(call);
          const [, server, toolName] = step.tool.split("__");
          if (permission.behavior === "allow" && step.durationMs) await sleep(step.durationMs, signal);
          if (permission.behavior === "allow") {
            // a platform tool runs its handler; any other allowed tool (external MCP, built-in) returns the script's output
            const cfg = server && toolName ? (options.mcpServers as Record<string, unknown> | undefined)?.[server] : undefined;
            const def = cfg ? toolDefsOf(cfg)?.find((d: SdkMcpToolDefinition) => d.name === toolName) : undefined;
            let response: unknown;
            if (def) {
              const r = await def.handler((permission.updatedInput ?? step.input) as never, {});
              call.output = r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
              resultText = call.output;
              isError = !!r.isError;
              response = r.content;
            } else if (step.error) {
              resultText = step.output ?? "external tool failed";
              isError = true;
            } else {
              resultText = step.output ?? "ok";
              response = [{ type: "text", text: resultText }];
            }
            // PostToolUse fires for successful calls only (failures go to PostToolUseFailure)
            if (!isError && response !== undefined) {
              const after = await postToolUse(options.hooks?.PostToolUse, step.tool, step.input, response, toolUseId, signal ?? new AbortController().signal);
              if (after !== response) resultText = toText(after);
              call.output = resultText;
            }
            if (isError) {
              call.output = resultText;
              call.failureContext = await postToolUseFailure(options.hooks?.PostToolUseFailure, step.tool, step.input, resultText, toolUseId, signal ?? new AbortController().signal);
            }
          } else if (permission.behavior === "deny") {
            resultText = permission.message;
            isError = true;
          }
          yield {
            type: "user",
            parent_tool_use_id: parent,
            session_id: "mock-session",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: resultText, is_error: isError }] },
          } as unknown as SDKMessage;
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
