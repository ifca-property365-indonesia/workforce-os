import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { classifyBash } from "@wfos/shared/bash-classifier";
import { recordStep } from "../../lib/steps";
import { createApproval, type RunContext } from "../../tools/registry";

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const FREE_TOOLS = new Set(["TodoWrite", "Task", "Agent", "Skill", "ExitPlanMode"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Absolute path inside the task workspace (or the run's private /tmp), and not git internals. */
export function writablePath(file: unknown, workspaceDir: string): { ok: true } | { ok: false; reason: string } {
  if (typeof file !== "string" || !file) return { ok: false, reason: "no file path" };
  const abs = path.posix.normalize(path.posix.isAbsolute(file) ? file : path.posix.join(workspaceDir, file));
  // DynamicUser state lives in <base>/private/…; the sandbox may report either form of the same directory
  const roots = [workspaceDir, workspaceDir.replace(/^(\/[^/]+\/[^/]+)\//, "$1/private/")];
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
  gateExternal: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** workspace root as the sandbox sees it */
  workspaceDir: string;
}

/**
 * canUseTool for Workspace mode. The sandbox limits what any tool can do; this decides what needs a human:
 * every Bash command is classified (approval card with the exact command when it is not provably local and
 * reversible), file writes stay inside the workspace, web tools go through the guarded platform web_fetch.
 */
export function workspacePermissions(d: WorkspacePermissionDeps): CanUseTool {
  const { ctx } = d;
  const step = (name: string, status: string, input: unknown, output?: unknown) =>
    recordStep({ workspaceId: ctx.workspaceId, taskId: ctx.taskId, conversationId: ctx.conversationId, employeeId: ctx.employee.id, kind: "tool", name, status, input, output });

  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName.startsWith("mcp__wfos__")) {
      return d.allowedPlatformTools.has(toolName) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Tool not granted to this employee." };
    }
    if (toolName.startsWith("mcp__")) return d.gateExternal(toolName, input);

    if (toolName === "Bash") {
      const command = String(input.command ?? "");
      const c = classifyBash(command, { tainted: ctx.guard.tainted });
      if (c.decision === "allow") {
        await step("bash", "ok", { command }, { category: c.category });
        return { behavior: "allow", updatedInput: input };
      }
      if (ctx.dryRun || ctx.sandboxed) {
        await step("simulated:bash", "simulated", { command }, { category: c.category, reasons: c.reasons });
        return { behavior: "deny", message: `DRY RUN: this command needs approval (${c.category}) and was not run. Treat it as recorded.` };
      }
      const id = await createApproval(
        ctx,
        "bash",
        `$ ${command.length > 90 ? `${command.slice(0, 87)}…` : command}`,
        c.reasons.join("; ") || `${c.category} command`,
        { command, category: c.category, reasons: c.reasons, commands: c.commands, hooksDisabled: c.hooksDisabled },
        [],
      );
      return {
        behavior: "deny",
        message:
          `Queued for human approval (id ${id}): ${c.reasons.join("; ")}. The command was NOT run. ` +
          "Do not retry it or work around it with a different command. Continue with other work; once approved, the platform runs exactly this command in your workspace and you get its output in a follow-up.",
      };
    }

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
