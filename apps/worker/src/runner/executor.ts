import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentQuery, workspaceQueryOverride } from "./sdk";
import { createWorkspaceQuery, type WorkspaceRunConfig } from "./workspace/query";
import { workspacePermissions } from "./workspace/permissions";
import { defaultSandboxHost, runLayout } from "./workspace/layout";
import { acquireWorkspaceSlot, releaseWorkspaceSlot } from "./workspace/slots";
import { CREDIT_USD, applyRunSignals, classifyTool, computeLlmCredits, decideGate, roundCredits } from "@wfos/shared";
import { resolveClaudeCredential } from "@wfos/db";
import { agentEnv, env } from "../lib/env";
import { log } from "../lib/logger";
import { priceFor } from "../lib/pricing";
import { recordStep } from "../lib/steps";
import { getExternalMcpServers } from "../lib/settings";
import { guardOutput } from "../guards/content";
import { registerRun, unregisterRun } from "../guards/killswitch";
import { buildToolServer, createApproval, grantedToolNames, WFOS_SERVER, type RunContext } from "../tools/registry";

export interface AgentRunInput {
  ctx: RunContext;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** credits this run may spend before it is stopped (daily/monthly remaining) */
  creditBudget: number;
  maxTurns?: number;
  onTextDelta?: (text: string) => void;
  /** record LLM steps under this name (e.g. "replay") */
  stepName?: string;
}

export interface AgentRunOutput {
  text: string;
  credits: number;
  stopped: "completed" | "budget" | "aborted" | "error" | "max_turns";
  error?: string;
}

export class MissingCredentialError extends Error {
  constructor() {
    super(
      "No Claude credential for this workspace. An Owner can add one in Settings → Claude (subscription token from `claude setup-token`, or an API key), or enable Demo Mode.",
    );
  }
}

/** All Workspace-mode slots on this host are taken; the task is retried shortly. */
export class WorkspaceBusyError extends Error {
  constructor() {
    super("All Workspace-mode slots on this server are busy");
  }
}

const BUILTIN_DENY = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "Task", "Agent", "TodoWrite", "Skill"];

/** Gate for tools that come from external MCP servers (built-in wfos tools gate themselves). */
export async function gateExternalTool(ctx: RunContext, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
  const server = toolName.split("__")[1] ?? "";
  const grant = ctx.employee.toolPermissions.find((p) => p.tool === `mcp:${server}` && p.enabled);
  if (!grant) return { behavior: "deny", message: `MCP server ${server} is not granted to this employee.` };
  const cls = classifyTool(toolName);
  const decision = applyRunSignals(
    decideGate({
      toolName: `mcp:${server}`,
      toolClass: cls,
      employeeAutonomy: ctx.employee.autonomyLevel,
      permissions: ctx.employee.toolPermissions,
      allowList: ctx.employee.allowList,
      dryRun: ctx.dryRun || ctx.sandboxed,
    }),
    { toolClass: cls, tainted: ctx.guard.tainted },
  );
  if (decision.kind === "run") return { behavior: "allow", updatedInput: input };
  if (decision.kind === "deny") return { behavior: "deny", message: decision.reason };
  if (decision.kind === "approval") {
    const id = await createApproval(ctx, toolName, `${toolName.split("__").slice(2).join("__")} via ${server}`, decision.reason, input, []);
    return { behavior: "deny", message: `Queued for human approval (id ${id}); not executed yet. Do not retry this call.` };
  }
  const reason = "reason" in decision ? decision.reason : "";
  await recordStep({
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    conversationId: ctx.conversationId,
    employeeId: ctx.employee.id,
    kind: "tool",
    name: `${decision.kind}:${toolName}`,
    status: decision.kind === "simulate" ? "simulated" : "drafted",
    input,
    output: { note: reason },
  });
  return { behavior: "deny", message: `${reason} The call was recorded but not executed.` };
}

interface OpenTurn {
  id: string;
  model: string;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { ctx } = input;
  // only this workspace's credential, only for this run
  const credential = await resolveClaudeCredential(ctx.workspaceId);
  if (!credential) throw new MissingCredentialError();
  if (ctx.workspace && !ctx.taskId) throw new Error("Workspace mode runs only for tasks");
  if (ctx.workspace && !(await acquireWorkspaceSlot(ctx.runId))) throw new WorkspaceBusyError();
  const controller = new AbortController();
  registerRun(ctx.runId, { workspaceId: ctx.workspaceId, taskId: ctx.taskId, employeeId: ctx.employee.id, controller });

  // per-workspace HOME: Claude Code keeps session transcripts there, which must not mix between tenants
  const home = path.join(env.storageDir, "agent-home", ctx.workspaceId);
  const cwd = path.join(env.storageDir, "sandbox", ctx.runId);
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const external = (await getExternalMcpServers(ctx.workspaceId)).filter((s) =>
    ctx.employee.toolPermissions.some((p) => p.enabled && p.tool === `mcp:${s.name}`),
  );
  const mcpServers: Record<string, unknown> = { [WFOS_SERVER]: buildToolServer(ctx) };
  for (const s of external) mcpServers[s.name] = { type: "http", url: s.url, headers: s.headers };

  let credits = 0;
  let stopped: AgentRunOutput["stopped"] = "completed";
  let error: string | undefined;
  let finalText = "";
  let lastAssistantText = "";
  const recordedMessageIds = new Set<string>();
  let turn: OpenTurn | null = null;
  let requestStartedAt = Date.now();

  const price = await priceFor(input.model);

  const closeTurn = async () => {
    if (!turn) return;
    const t = turn;
    turn = null;
    if (recordedMessageIds.has(t.id)) return;
    recordedMessageIds.add(t.id);
    const c = computeLlmCredits(
      { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite },
      (await priceFor(t.model)) ?? price,
    );
    credits = roundCredits(credits + c);
    await recordStep({
      workspaceId: ctx.workspaceId,
      taskId: ctx.taskId,
      conversationId: ctx.conversationId,
      employeeId: ctx.employee.id,
      kind: "llm",
      name: input.stepName ?? "llm_call",
      model: t.model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheRead,
      cacheWriteTokens: t.cacheWrite,
      latencyMs: Date.now() - t.startedAt,
      credits: c,
    });
    if (credits >= input.creditBudget) {
      stopped = "budget";
      controller.abort(new Error("budget"));
    }
  };

  const allowed = new Set(grantedToolNames(ctx));
  const toolModePermissions = async (toolName: string, toolInput: Record<string, unknown>): Promise<PermissionResult> => {
    if (toolName.startsWith(`mcp__${WFOS_SERVER}__`)) {
      return allowed.has(toolName) ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "Tool not granted to this employee." };
    }
    if (toolName.startsWith("mcp__")) return gateExternalTool(ctx, toolName, toolInput);
    return { behavior: "deny", message: "Built-in tools are disabled for AI employees." };
  };
  let runQuery = agentQuery;
  let canUseTool: CanUseTool = toolModePermissions;
  if (ctx.workspace) {
    const host = defaultSandboxHost();
    const cfg: WorkspaceRunConfig = {
      workspaceId: ctx.workspaceId,
      taskId: ctx.taskId!,
      credential,
      egressAllow: ctx.workspace.egressDomains,
      gitIdentity: { name: `${ctx.employee.name} (AI)`, email: `agent+${ctx.employee.id.slice(0, 8)}@workforce-os.local` },
      host,
      onGatewayEvent: (e) => {
        if (e.kind === "egress_denied") {
          void recordStep({ workspaceId: ctx.workspaceId, taskId: ctx.taskId, employeeId: ctx.employee.id, kind: "guard", name: "egress_blocked", status: "blocked", output: e.detail });
        }
      },
    };
    const override = workspaceQueryOverride();
    runQuery = override ? override(cfg) : createWorkspaceQuery(cfg);
    canUseTool = workspacePermissions({
      ctx,
      allowedPlatformTools: allowed,
      gateExternal: (n, i) => gateExternalTool(ctx, n, i),
      workspaceDir: runLayout(host, { runId: ctx.runId, workspaceId: ctx.workspaceId, taskId: ctx.taskId! }).sandboxRepoDir,
    });
  }

  try {
    const q = runQuery({
      prompt: input.prompt,
      options: {
        abortController: controller,
        model: input.model,
        systemPrompt: input.systemPrompt,
        cwd,
        env: agentEnv(home, credential),
        tools: [],
        disallowedTools: BUILTIN_DENY,
        mcpServers: mcpServers as never,
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "default",
        includePartialMessages: true,
        maxTurns: input.maxTurns ?? 30,
        maxBudgetUsd: Math.max(0.01, input.creditBudget * CREDIT_USD),
        canUseTool: (toolName, toolInput, opts) => canUseTool(toolName, toolInput, opts),
        ...(ctx.workspace?.resume ? { resume: ctx.workspace.resume } : {}),
        stderr: (d) => log.debug({ runId: ctx.runId, d: d.slice(0, 500) }, "sdk stderr"),
      },
    });

    for await (const m of q as AsyncIterable<SDKMessage>) {
      switch (m.type) {
        case "stream_event": {
          if (m.parent_tool_use_id) break;
          const ev = m.event;
          if (ev.type === "message_start") {
            await closeTurn();
            const u = ev.message.usage;
            turn = {
              id: ev.message.id,
              model: ev.message.model,
              startedAt: requestStartedAt,
              inputTokens: u?.input_tokens ?? 0,
              outputTokens: u?.output_tokens ?? 0,
              cacheRead: u?.cache_read_input_tokens ?? 0,
              cacheWrite: u?.cache_creation_input_tokens ?? 0,
            };
          } else if (ev.type === "message_delta" && turn) {
            const u = ev.usage as { output_tokens?: number; input_tokens?: number | null } | undefined;
            if (u?.output_tokens != null) turn.outputTokens = u.output_tokens;
            if (u?.input_tokens) turn.inputTokens = u.input_tokens;
          } else if (ev.type === "message_stop") {
            await closeTurn();
          } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            input.onTextDelta?.(ev.delta.text);
          }
          break;
        }
        case "assistant": {
          if (m.parent_tool_use_id) break;
          if (m.error) error = `Claude API error: ${m.error}`;
          const text = m.message.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (text) lastAssistantText = text;
          // Fallback accounting when no stream events were delivered for this message.
          if (!recordedMessageIds.has(m.message.id) && (!turn || turn.id !== m.message.id) && m.message.stop_reason) {
            const u = m.message.usage;
            turn = {
              id: m.message.id,
              model: m.message.model,
              startedAt: requestStartedAt,
              inputTokens: u?.input_tokens ?? 0,
              outputTokens: u?.output_tokens ?? 0,
              cacheRead: u?.cache_read_input_tokens ?? 0,
              cacheWrite: u?.cache_creation_input_tokens ?? 0,
            };
            await closeTurn();
          }
          break;
        }
        case "user": {
          // tool results returned → the next model request starts now
          requestStartedAt = Date.now();
          break;
        }
        case "system": {
          if (m.subtype === "init" && ctx.workspace?.onSession) await ctx.workspace.onSession(m.session_id);
          if (m.subtype === "compact_boundary") {
            await recordStep({
              workspaceId: ctx.workspaceId,
              taskId: ctx.taskId,
              conversationId: ctx.conversationId,
              employeeId: ctx.employee.id,
              kind: "compaction",
              name: `context_compaction (${m.compact_metadata.trigger})`,
              inputTokens: m.compact_metadata.pre_tokens,
              outputTokens: m.compact_metadata.post_tokens ?? 0,
              latencyMs: m.compact_metadata.duration_ms ?? 0,
              output: { preTokens: m.compact_metadata.pre_tokens, postTokens: m.compact_metadata.post_tokens },
            });
          }
          break;
        }
        case "result": {
          await closeTurn();
          if (m.subtype === "success") {
            finalText = m.result;
          } else {
            if (m.subtype === "error_max_turns") stopped = "max_turns";
            else if (m.subtype === "error_max_budget_usd") stopped = "budget";
            else {
              stopped = "error";
              error = m.errors?.join("; ") || error || m.subtype;
            }
          }
          break;
        }
        default:
          break;
      }
    }
    await closeTurn();
  } catch (e) {
    await closeTurn().catch(() => {});
    const reason = controller.signal.reason as Error | undefined;
    if (stopped === "budget" || reason?.message === "budget") stopped = "budget";
    else if (controller.signal.aborted) {
      stopped = "aborted";
      error = reason?.message ?? "aborted";
    } else {
      stopped = "error";
      error = (e as Error).message;
    }
  } finally {
    unregisterRun(ctx.runId);
    if (ctx.workspace) await releaseWorkspaceSlot(ctx.runId);
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }

  const raw = finalText || lastAssistantText;
  const { text } = await guardOutput(ctx.guard, "final answer", raw);
  if (error && stopped === "completed" && !raw) stopped = "error";
  return { text, credits, stopped, error };
}
