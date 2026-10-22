import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { computeLlmCredits, roundCredits, type TokenUsage } from "@wfos/shared";
import { resolveClaudeCredential } from "@wfos/db";
import { agentEnv, env } from "../lib/env";
import { log } from "../lib/logger";
import { priceFor } from "../lib/pricing";
import { agentQuery } from "./sdk";
import { BUILTIN_DENY } from "./executor";

export interface OneTurnResult {
  /** the model's final text ("" when it failed) */
  text: string;
  model: string;
  usage: Required<TokenUsage>;
  credits: number;
  latencyMs: number;
  /** why there is no answer: the timeout fired, the SDK reported a failed result, or something threw */
  failure: "timeout" | "error" | null;
}

/**
 * One model turn with no tools at all (the same built-ins the executor denies), on the workspace's own Claude
 * credential, in a throwaway directory: for small decisions (team chat routing, webhook triage, a stop summary).
 * Never throws: a missing credential, a failure or the timeout come back as `failure`.
 */
export async function oneTurn(input: { workspaceId: string; model: string; systemPrompt: string; prompt: string; timeoutMs: number; label: string }): Promise<OneTurnResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${input.label} timeout`));
  }, input.timeoutMs);
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let model = input.model;
  let text = "";
  let failure: OneTurnResult["failure"] = null;
  const cwd = path.join(env.storageDir, "sandbox", `${input.label}-${randomUUID()}`);
  try {
    const credential = await resolveClaudeCredential(input.workspaceId);
    if (!credential) throw new Error("no Claude credential");
    const home = path.join(env.storageDir, "agent-home", input.workspaceId);
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    // the timeout may already have fired while resolving the credential / preparing the directory
    if (controller.signal.aborted) {
      timedOut = true;
      throw new Error(`${input.label} timeout before the query started`);
    }
    const q = agentQuery({
      prompt: input.prompt,
      options: {
        abortController: controller,
        model: input.model,
        systemPrompt: input.systemPrompt,
        cwd,
        env: agentEnv(home, credential),
        tools: [],
        disallowedTools: BUILTIN_DENY,
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "default",
        maxTurns: 1,
        canUseTool: async () => ({ behavior: "deny", message: "No tools here." }),
        stderr: (d) => log.debug({ label: input.label, d: d.slice(0, 500) }, "one-turn stderr"),
      },
    });
    const seen = new Set<string>();
    let failed = false;
    // the timeout aborts the SDK; the race also covers an implementation that ignores the signal
    const consume = (async () => {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === "assistant" && !m.parent_tool_use_id) {
          const t = m.message.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
          if (!seen.has(m.message.id)) {
            seen.add(m.message.id);
            const u = m.message.usage;
            model = m.message.model || model;
            usage.inputTokens += u?.input_tokens ?? 0;
            usage.outputTokens += u?.output_tokens ?? 0;
            usage.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens += u?.cache_creation_input_tokens ?? 0;
          }
        } else if (m.type === "result") {
          if (m.subtype === "success") text = m.result || text;
          else failed = true;
        }
      }
    })();
    await Promise.race([
      consume,
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ]);
    if (failed) failure = "error";
  } catch (e) {
    failure = timedOut ? "timeout" : "error";
    if (!timedOut) log.warn({ err: e instanceof Error ? e.message : String(e), label: input.label }, "one-turn call failed");
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error(`${input.label} done`));
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
  const credits = roundCredits(computeLlmCredits(usage, (await priceFor(model).catch(() => undefined)) ?? (await priceFor(input.model).catch(() => undefined))));
  return { text: failure ? "" : text, model, usage, credits, latencyMs: Date.now() - startedAt, failure };
}
