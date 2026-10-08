import { employeeOutputLocale } from "@wfos/shared";
import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { conversations, db, employees, messages, teams } from "@wfos/db";
import type { ChatMessageDTO } from "@wfos/shared";
import { publish } from "../lib/redis";
import { getWorkspace } from "../lib/settings";
import { recordStep } from "../lib/steps";
import { checkBudget, pauseForBudget } from "../guards/budget";
import { grantedToolNames, type RunContext } from "../tools/registry";
import { buildSystemPrompt, recallMemories, workspaceDirectory } from "./prompt";
import { MissingCredentialError, runAgent } from "./executor";
import { activeQuotaPause } from "../lib/limits";
import { enqueueTask } from "../lib/redis";
import { scriptedChatReply } from "../simulation/demo";

function dto(m: typeof messages.$inferSelect): ChatMessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    employeeId: m.employeeId,
    taskId: m.taskId,
    attachments: m.attachments,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function runChat(conversationId: string, userMessageId: string): Promise<void> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return;
  const ws = await getWorkspace(conv.workspaceId);
  let employeeId = conv.employeeId;
  if (!employeeId && conv.teamId) {
    const [t] = await db.select().from(teams).where(eq(teams.id, conv.teamId));
    employeeId = t?.leadId ?? null;
  }
  if (!employeeId) return;
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  if (!emp) return;

  const [assistant] = await db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: "", employeeId: emp.id, status: "streaming" })
    .returning();
  await publish(ws.id, { type: "chat.message", conversationId, message: dto(assistant!) });

  const finish = async (content: string, status: "done" | "error") => {
    const [m] = await db.update(messages).set({ content, status }).where(eq(messages.id, assistant!.id)).returning();
    await publish(ws.id, { type: "chat.message", conversationId, message: dto(m!) });
  };

  if (ws.killSwitch) return finish("⛔ The workspace kill switch is engaged. All employees are stopped.", "error");
  if (emp.status !== "ACTIVE") return finish(`${emp.name} is ${emp.status.toLowerCase().replace("_", " ")} and cannot reply right now.`, "error");

  const history = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.createdAt)).limit(21);
  const ordered = history.reverse().filter((m) => m.id !== assistant!.id);
  const latest = ordered.find((m) => m.id === userMessageId) ?? ordered[ordered.length - 1];

  if (ws.demoMode) {
    const text = scriptedChatReply(emp.name, emp.role, latest?.content ?? "");
    let acc = "";
    for (const word of text.split(/(\s+)/)) {
      acc += word;
      await publish(ws.id, { type: "chat.delta", conversationId, messageId: assistant!.id, text: word });
      await new Promise((r) => setTimeout(r, 25));
    }
    await recordStep({ workspaceId: ws.id, conversationId, employeeId: emp.id, kind: "llm", name: "demo_script", model: "demo-script", inputTokens: 0, outputTokens: 0, credits: 0 });
    return finish(acc, "done");
  }

  const budget = await checkBudget(ws.id, emp.id);
  if (!budget.ok) {
    await pauseForBudget(ws.id, emp.id, budget.reason!);
    return finish(`⏸ ${emp.name} is paused: ${budget.reason}. An admin can raise the budget and resume.`, "error");
  }

  const ctx: RunContext = {
    runId: randomUUID(),
    workspaceId: ws.id,
    employee: { id: emp.id, name: emp.name, role: emp.role, autonomyLevel: emp.autonomyLevel, toolPermissions: emp.toolPermissions, allowList: emp.allowList },
    taskId: null,
    conversationId,
    dryRun: false,
    sandboxed: false,
    guard: { workspaceId: ws.id, taskId: null, conversationId, employeeId: emp.id, enabled: ws.guardsEnabled, tainted: false },
    pendingApprovalIds: [],
    deliverables: [],
    createdTaskIds: [],
    delegatedTaskIds: [],
    revisionRequests: [],
  };

  const transcript = ordered
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "User" : emp.name}: ${m.content}${m.attachments.length ? ` [attachments: ${m.attachments.map((a) => a.name).join(", ")}]` : ""}`)
    .join("\n\n");
  const attach = latest?.attachments.length
    ? `\n\n(The user attached: ${latest.attachments.map((a) => a.name).join(", ")}. Attached documents are indexed in the knowledge base; use kb_search to read them.)`
    : "";
  const prompt = `${transcript ? `Conversation so far:\n${transcript}\n\n---\n` : ""}User: ${latest?.content ?? ""}${attach}`;

  const systemPrompt = buildSystemPrompt({
    employee: emp,
    workspaceName: ws.name,
    memories: await recallMemories(emp.id, latest?.content ?? ""),
    directory: await workspaceDirectory(ws.id),
    grantedTools: grantedToolNames(ctx).map((n) => n.split("__").pop()!),
    dryRun: false,
    mode: "chat",
    outputLocale: employeeOutputLocale(emp.outputLanguage, ws.defaultLocale),
  });

  let buffer = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = async () => {
    timer = null;
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    await publish(ws.id, { type: "chat.delta", conversationId, messageId: assistant!.id, text });
  };

  try {
    const out = await runAgent({
      ctx,
      model: emp.model,
      systemPrompt,
      prompt,
      creditBudget: budget.remaining,
      maxTurns: 15,
      onTextDelta: (t) => {
        buffer += t;
        if (!timer) timer = setTimeout(() => void flush(), 80);
      },
    });
    if (timer) clearTimeout(timer);
    await flush();
    for (const id of ctx.createdTaskIds) await enqueueTask(id, ws.id);
    if (out.stopped === "budget") await pauseForBudget(ws.id, emp.id, "Budget reached during chat");
    let content = out.text || (out.error ? `⚠️ ${out.error}` : "(no reply)");
    if (out.stopped === "quota") {
      const pause = await activeQuotaPause(ws.id);
      content = `${out.text ? `${out.text}\n\n` : ""}⏸️ ${pause?.reason ?? "The Claude subscription limit was reached."}`;
    }
    if (ctx.pendingApprovalIds.length) content += `\n\n🔒 ${ctx.pendingApprovalIds.length} action(s) are waiting in the Approvals inbox.`;
    if (ctx.createdTaskIds.length && ctx.createdTaskIds[0]) {
      await db.update(messages).set({ taskId: ctx.createdTaskIds[0] }).where(eq(messages.id, assistant!.id));
    }
    await finish(content, out.stopped === "error" || out.stopped === "quota" ? "error" : "done");
  } catch (e) {
    if (timer) clearTimeout(timer);
    const msg = e instanceof MissingCredentialError ? e.message : `Runner error: ${(e as Error).message}`;
    await recordStep({ workspaceId: ws.id, conversationId, employeeId: emp.id, kind: "error", name: "runner_error", status: "error", output: msg });
    await finish(`⚠️ ${msg}`, "error");
  }
}

export async function conversationMessages(conversationId: string) {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
}
