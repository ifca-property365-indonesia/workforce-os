import { randomUUID } from "node:crypto";
import { approvals, credentials, db, employees, tasks, workspaces } from "@wfos/db";
import type { AllowListEntry, AutonomyLevel, ToolPermission } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import type { RunContext } from "../src/tools/registry";

export async function makeWorkspace(over: Partial<typeof workspaces.$inferInsert> = {}) {
  const [ws] = await db
    .insert(workspaces)
    .values({ name: "Test WS", slug: `t-${randomUUID().slice(0, 8)}`, ...over })
    .returning();
  await db.insert(credentials).values({
    workspaceId: ws!.id,
    kind: "smtp",
    name: "default",
    config: { host: "smtp.invalid", port: 587, secure: false, user: "u", fromAddress: "bot@test.invalid" },
    secretEnc: encryptSecret("smtp-pass"),
  });
  return ws!;
}

export async function makeEmployee(
  workspaceId: string,
  over: { autonomyLevel?: AutonomyLevel; toolPermissions?: ToolPermission[]; allowList?: AllowListEntry[]; dailyBudget?: number } = {},
) {
  const [e] = await db
    .insert(employees)
    .values({
      workspaceId,
      name: "Sari",
      role: "Finance",
      model: "claude-sonnet-5-5",
      autonomyLevel: over.autonomyLevel ?? "EXECUTE",
      toolPermissions: over.toolPermissions ?? [{ tool: "send_email", enabled: true }],
      allowList: over.allowList ?? [],
      dailyBudget: over.dailyBudget ?? 200,
    })
    .returning();
  return e!;
}

export async function makeTask(workspaceId: string, assigneeId: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const [t] = await db.insert(tasks).values({ workspaceId, assigneeId, title: "Test task", brief: "Do it", ...over }).returning();
  return t!;
}

export async function makeApproval(workspaceId: string, taskId: string | null, employeeId: string, over: Partial<typeof approvals.$inferInsert> = {}) {
  const [a] = await db
    .insert(approvals)
    .values({
      workspaceId,
      taskId,
      employeeId,
      toolName: "send_email",
      title: "Email",
      payload: { to: ["original@client.co.id"], cc: [], subject: "Original", body: "Original body", html: false },
      ...over,
    })
    .returning();
  return a!;
}

export function runContext(
  ws: { id: string },
  emp: Awaited<ReturnType<typeof makeEmployee>>,
  taskId: string | null,
  over: Partial<RunContext> = {},
): RunContext {
  return {
    runId: randomUUID(),
    workspaceId: ws.id,
    employee: { id: emp.id, name: emp.name, role: emp.role, autonomyLevel: emp.autonomyLevel, toolPermissions: emp.toolPermissions, allowList: emp.allowList },
    taskId,
    conversationId: null,
    dryRun: false,
    sandboxed: false,
    guard: { workspaceId: ws.id, taskId, conversationId: null, employeeId: emp.id, enabled: true, tainted: false },
    pendingApprovalIds: [],
    deliverables: [],
    createdTaskIds: [],
    delegatedTaskIds: [],
    revisionRequests: [],
    ...over,
  };
}
