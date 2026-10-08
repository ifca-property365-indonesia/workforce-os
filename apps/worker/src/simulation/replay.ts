import { employeeOutputLocale } from "@wfos/shared";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { createTwoFilesPatch } from "diff";
import { db, employees, replays, tasks } from "@wfos/db";
import { roundCredits } from "@wfos/shared";
import { publish } from "../lib/redis";
import { getWorkspace } from "../lib/settings";
import { log } from "../lib/logger";
import { checkBudget } from "../guards/budget";
import { grantedToolNames, type RunContext } from "../tools/registry";
import { buildSystemPrompt, recallMemories, workspaceDirectory } from "../runner/prompt";
import { runAgent } from "../runner/executor";

/**
 * Replay: re-run the employee's last N completed tasks with the proposed instructions, in a sandbox
 * (dry run, no approvals, no side effects), and store old vs new outputs with a diff.
 */
export async function runReplay(replayId: string): Promise<void> {
  const [rp] = await db.select().from(replays).where(eq(replays.id, replayId));
  if (!rp || rp.status !== "queued") return;
  const ws = await getWorkspace(rp.workspaceId);
  const [emp] = await db.select().from(employees).where(eq(employees.id, rp.employeeId));
  if (!emp) return;
  await db.update(replays).set({ status: "running" }).where(eq(replays.id, rp.id));
  await publish(ws.id, { type: "replay.updated", replayId: rp.id, status: "running" });

  const past = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.assigneeId, emp.id), eq(tasks.status, "DONE"), isNotNull(tasks.result), inArray(tasks.source, ["board", "routine", "chat", "team"])))
    .orderBy(desc(tasks.completedAt))
    .limit(rp.sampleSize);

  const results: (typeof replays.$inferSelect)["results"] = [];
  let total = 0;
  try {
    if (!past.length) throw new Error("No completed tasks to replay yet. Complete at least one task first.");
    for (const t of past) {
      let newOutput: string;
      let credits = 0;
      if (ws.demoMode) {
        newOutput = `${t.result ?? ""}\n\n[Demo replay] Output regenerated with the proposed instructions (scripted, 0 credits).`;
      } else {
        const budget = await checkBudget(ws.id, emp.id);
        if (!budget.ok) throw new Error(`Replay stopped: ${budget.reason}`);
        const ctx: RunContext = {
          runId: randomUUID(),
          workspaceId: ws.id,
          employee: { id: emp.id, name: emp.name, role: emp.role, autonomyLevel: emp.autonomyLevel, toolPermissions: emp.toolPermissions, allowList: emp.allowList },
          taskId: null,
          conversationId: null,
          dryRun: true,
          sandboxed: true,
          guard: { workspaceId: ws.id, taskId: null, conversationId: null, employeeId: emp.id, enabled: ws.guardsEnabled, tainted: false },
          pendingApprovalIds: [],
          deliverables: [],
          createdTaskIds: [],
          delegatedTaskIds: [],
          revisionRequests: [],
        };
        // Replays must not create tasks or delegate: strip those tools.
        ctx.employee.toolPermissions = ctx.employee.toolPermissions.filter((p) => !["create_task", "delegate_subtask", "message_teammate", "memory_save"].includes(p.tool));
        const systemPrompt = buildSystemPrompt({
          employee: emp,
          overrides: rp.proposed,
          workspaceName: ws.name,
          memories: await recallMemories(emp.id, `${t.title}\n${t.brief}`),
          directory: await workspaceDirectory(ws.id),
          grantedTools: grantedToolNames(ctx).map((n) => n.split("__").pop()!),
          dryRun: true,
          mode: "task",
          outputLocale: employeeOutputLocale(emp.outputLanguage, ws.defaultLocale),
        });
        const out = await runAgent({ ctx, model: emp.model, systemPrompt, prompt: `# Task: ${t.title}\n${t.brief}`, creditBudget: budget.remaining, stepName: "replay", maxTurns: 15 });
        const drafts = ctx.deliverables.map((d) => `### ${d.title}\n${d.content}`).join("\n\n");
        newOutput = [out.text, drafts].filter(Boolean).join("\n\n") || `(no output: ${out.error ?? out.stopped})`;
        credits = out.credits;
      }
      const oldDrafts = t.deliverables.filter((d) => d.kind !== "simulated_action").map((d) => `### ${d.title}\n${d.content}`).join("\n\n");
      const oldOutput = [t.result ?? "", oldDrafts].filter(Boolean).join("\n\n");
      total = roundCredits(total + credits);
      results.push({ taskId: t.id, title: t.title, oldOutput, newOutput, diff: createTwoFilesPatch("current", "proposed", oldOutput, newOutput), credits });
      await db.update(replays).set({ results, costCredits: total }).where(eq(replays.id, rp.id));
      await publish(ws.id, { type: "replay.updated", replayId: rp.id, status: "running" });
    }
    await db.update(replays).set({ status: "done", results, costCredits: total }).where(eq(replays.id, rp.id));
    await publish(ws.id, { type: "replay.updated", replayId: rp.id, status: "done" });
  } catch (e) {
    log.warn({ err: e, replayId }, "replay failed");
    await db.update(replays).set({ status: "failed", error: (e as Error).message, results, costCredits: total }).where(eq(replays.id, rp.id));
    await publish(ws.id, { type: "replay.updated", replayId: rp.id, status: "failed" });
  }
}
