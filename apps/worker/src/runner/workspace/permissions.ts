import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { classifyBash, workspaceRootVariants } from "@wfos/shared/bash-classifier";
import { recordStep } from "../../lib/steps";
import { createApproval, type RunContext } from "../../tools/registry";
import { leadReviewable, reviewSandboxCommand } from "./lead-review";

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const FREE_TOOLS = new Set(["TodoWrite", "Task", "Agent", "Skill", "ExitPlanMode"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Claude Code's subagent tool (Task, or Agent in newer CLIs) */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** Absolute path inside the task workspace (or the run's private /tmp), and not git internals. */
export function writablePath(file: unknown, workspaceDir: string): { ok: true } | { ok: false; reason: string } {
  if (typeof file !== "string" || !file) return { ok: false, reason: "no file path" };
  const abs = path.posix.normalize(path.posix.isAbsolute(file) ? file : path.posix.join(workspaceDir, file));
  // DynamicUser state lives in <base>/private/…; the sandbox may report either form of the same directory
  const roots = workspaceRootVariants(workspaceDir);
  const inside = roots.some((r) => abs === r || abs.startsWith(`${r}/`)) || abs.startsWith("/tmp/");
  if (!inside) return { ok: false, reason: `${file} is outside the workspace` };
  if (/\/\.git\/(hooks|config|info\/attributes)(\/|$)|\/\.git$/.test(abs)) return { ok: false, reason: `${file} is git configuration or hooks` };
  return { ok: true };
}

export interface WorkspacePermissionDeps {
  ctx: RunContext;
  /** platform tool names the employee is granted (mcp__wfos__…) */
  allowedPlatformTools: Set<string>;
  /** gate for tools from external MCP servers (shared with Tool mode) */
  gateExternal: (toolName: string, input: Record<string, unknown>, toolUseID?: string) => Promise<PermissionResult>;
  /** workspace root as the sandbox sees it */
  workspaceDir: string;
}

/**
 * canUseTool for Workspace mode. The sandbox limits what any tool can do; this decides what needs a human:
 * every Bash command is classified; one that is not provably local and reversible is reviewed by the division's AI
 * lead when there is one (lead-review.ts) and otherwise, or when the lead escalates, becomes an approval card with the
 * exact command. File writes stay inside the workspace, web tools go through the guarded platform web_fetch.
 */
export function workspacePermissions(d: WorkspacePermissionDeps): CanUseTool {
  const { ctx } = d;
  const step = (name: string, status: string, input: unknown, output?: unknown) =>
    recordStep({ workspaceId: ctx.workspaceId, taskId: ctx.taskId, conversationId: ctx.conversationId, employeeId: ctx.employee.id, kind: "tool", name, status, input, output });

  return async (toolName, input, opts): Promise<PermissionResult> => {
    if (toolName.startsWith("mcp__wfos__")) {
      return d.allowedPlatformTools.has(toolName) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Tool not granted to this employee." };
    }
    if (toolName.startsWith("mcp__")) return d.gateExternal(toolName, input, opts?.toolUseID);

    if (toolName === "Bash") {
      const command = String(input.command ?? "");
      // the sandbox's egress goes through the employee's registry allow-list only: locked installs are local there
      const c = classifyBash(command, { tainted: ctx.guard.tainted, workspaceDir: d.workspaceDir, egressRestricted: true });
      if (c.decision === "allow") {
        await step("bash", "ok", { command }, { category: c.category });
        return { behavior: "allow", updatedInput: input };
      }
      if (ctx.dryRun || ctx.sandboxed) {
        await step("simulated:bash", "simulated", { command }, { category: c.category, reasons: c.reasons });
        return { behavior: "deny", message: `DRY RUN: this command needs approval (${c.category}) and was not run. Treat it as recorded.` };
      }
      // approval tiers: the division's AI lead decides first (never for publish / sensitive, never in a tainted run)
      const agentId = (opts as { agentID?: string } | undefined)?.agentID;
      const reviewer = agentId ? ctx.workspace?.review?.subagents : ctx.workspace?.review?.own;
      let leadReview: { decision: string; reason: string; reviewer: string } | null = null;
      if (reviewer && ctx.workspace?.review && leadReviewable(c.category, ctx.guard.tainted)) {
        const r = await reviewSandboxCommand({
          ctx,
          reviewer,
          command,
          category: c.category,
          reasons: c.reasons,
          by: agentId ? "subagent" : "self",
          agentId,
          task: ctx.workspace.review.task,
          workspaceDir: d.workspaceDir,
          signal: opts?.signal,
        });
        if (r.decision === "allow") return { behavior: "allow", updatedInput: input };
        if (r.source === "aborted") return { behavior: "deny", message: "The run was stopped; the command was not run." };
        if (r.decision === "deny") {
          return {
            behavior: "deny",
            message:
              `Denied by ${reviewer.name} (AI review): ${r.reason} The command was NOT run. ` +
              "Do not retry it or work around it with a different command. Change your approach, or explain in your report what you needed and why.",
          };
        }
        leadReview = { decision: r.decision, reason: r.reason, reviewer: reviewer.name };
      }
      const id = await createApproval(
        ctx,
        "bash",
        `$ ${command.length > 90 ? `${command.slice(0, 87)}…` : command}`,
        c.reasons.join("; ") || `${c.category} command`,
        { command, category: c.category, reasons: c.reasons, commands: c.commands, hooksDisabled: c.hooksDisabled, ...(leadReview ? { leadReview } : {}) },
        [],
      );
      return {
        behavior: "deny",
        message:
          `Queued for human approval (id ${id}): ${c.reasons.join("; ")}. The command was NOT run. ` +
          "Do not retry it or work around it with a different command. Continue with other work; once approved, the platform runs exactly this command in your workspace and you get its output in a follow-up.",
      };
    }

    // subagents run in the foreground: the code lead waits for their reports, so the run cannot end (and the sandbox
    // stop) while a subagent still works or waits for a permission (the trial's lost approvals)
    if (SUBAGENT_TOOLS.has(toolName) && input.run_in_background === true) return { behavior: "allow", updatedInput: { ...input, run_in_background: false } };
    if (READ_TOOLS.has(toolName) || FREE_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };

    if (WRITE_TOOLS.has(toolName)) {
      const w = writablePath(input.file_path ?? input.notebook_path, d.workspaceDir);
      if (!w.ok) {
        await step(`denied:${toolName}`, "denied", { file: input.file_path ?? input.notebook_path }, { reason: w.reason });
        return { behavior: "deny", message: `${w.reason}. Only files inside your workspace can be written.` };
      }
      return { behavior: "allow", updatedInput: input };
    }

    if (toolName === "WebFetch" || toolName === "WebSearch") {
      return { behavior: "deny", message: "Use the web_fetch platform tool (it screens untrusted content)." };
    }
    return { behavior: "deny", message: `${toolName} is not available in Workspace mode.` };
  };
}
