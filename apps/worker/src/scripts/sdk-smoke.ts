/** Runs one real Claude Agent SDK query for an employee (uses the configured credential). */
import "../lib/env";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, employees } from "@wfos/db";
import { runAgent } from "../runner/executor";
import type { RunContext } from "../tools/registry";

const [employeeId, prompt = "Reply with exactly: pong"] = process.argv.slice(2);
const [e] = await db.select().from(employees).where(eq(employees.id, employeeId!));
const ctx: RunContext = {
  runId: randomUUID(), workspaceId: e!.workspaceId,
  employee: { id: e!.id, name: e!.name, role: e!.role, autonomyLevel: e!.autonomyLevel, toolPermissions: e!.toolPermissions, allowList: e!.allowList },
  taskId: null, conversationId: null, dryRun: true, sandboxed: true,
  guard: { workspaceId: e!.workspaceId, taskId: null, conversationId: null, employeeId: e!.id, enabled: true, tainted: false },
  pendingApprovalIds: [], deliverables: [], createdTaskIds: [], delegatedTaskIds: [], revisionRequests: [],
};
const t = Date.now();
const out = await runAgent({ ctx, model: e!.model, systemPrompt: `You are ${e!.name}.`, prompt, creditBudget: 5, maxTurns: 3, onTextDelta: (d) => process.stdout.write(d) });
console.log("\n", JSON.stringify({ ...out, ms: Date.now() - t }));
process.exit(0);
