import { employeeOutputLocale } from "@wfos/shared";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { conversations, db, employees, messages, teams } from "@wfos/db";
import { publish } from "../lib/redis";
import { log } from "../lib/logger";
import { getWorkspace } from "../lib/settings";
import { recordStep } from "../lib/steps";
import { checkBudget, pauseForBudget } from "../guards/budget";
import { grantedToolNames, type RunContext } from "../tools/registry";
import { buildSystemPrompt, recallMemories, workspaceDirectory } from "./prompt";
import { MissingCredentialError, runAgent } from "./executor";
import { activeQuotaPause } from "../lib/limits";
import { enqueueTask } from "../lib/redis";
import { scriptedChatReply } from "../simulation/demo";
import { errorMessage } from "../lib/errors";
import { chatMessageDto } from "./chat-turns";

type MessageRow = typeof messages.$inferSelect;

/**
 * Claim every user message of the conversation that no run has answered yet, and open the
 * assistant row for the turn, in one transaction: rapid messages coalesce into a single reply.
 * Returns null when there is nothing to claim (an earlier job already folded this message in).
 */
async function claimTurn(conversationId: string, employeeId: string): Promise<{ claimed: MessageRow[]; assistant: MessageRow } | null> {
  return db.transaction(async (tx) => {
    // Deploy window: a worker from before turns existed may have answered messages after migration
    // 0013 ran, leaving them unhandled. Its replies are assistant rows without meta.turnMessageIds;
    // a user message older than the latest such reply was answered, so it is marked handled (not
    // answered again).
    await tx
      .update(messages)
      .set({ handledAt: sql`now()` })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, "user"),
          isNull(messages.handledAt),
          sql`${messages.createdAt} < (select max(a.created_at) from messages a where a.conversation_id = ${conversationId} and a.role = 'assistant' and not (a.meta ? 'turnMessageIds'))`,
        ),
      );
    // Concurrent claims serialise on the row locks; the loser re-checks handled_at and skips.
    const ids = await tx
      .update(messages)
      .set({ handledAt: sql`now()` })
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user"), isNull(messages.handledAt)))
      .returning({ id: messages.id });
    if (!ids.length) return null;
    const claimed = await tx
      .select()
      .from(messages)
      .where(inArray(messages.id, ids.map((r) => r.id)))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const [assistant] = await tx
      .insert(messages)
      .values({ conversationId, role: "assistant", content: "", employeeId, status: "streaming", meta: { turnMessageIds: claimed.map((m) => m.id) } })
      .returning();
    return { claimed, assistant: assistant! };
  });
}

/**
 * Up to `limit` messages before `firstId`, oldest first, by (created_at, id). The comparison runs
 * in SQL so microsecond timestamps are not truncated to JS milliseconds. Assistant rows still
 * streaming (another run in flight, or one that died mid-reply) are left out.
 */
async function transcriptBefore(conversationId: string, firstId: string, limit = 20): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`(${messages.createdAt}, ${messages.id}) < (select m.created_at, m.id from messages m where m.id = ${firstId})`,
        not(and(eq(messages.role, "assistant"), eq(messages.status, "streaming"))!),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

const attachmentNames = (ms: MessageRow[]) => ms.flatMap((m) => m.attachments.map((a) => a.name));

/**
 * Answer the conversation's pending user messages as one turn. `userMessageId` is the message
 * that queued the job; the run claims it together with any other unanswered messages.
 *
 * Retry behaviour: the claim and the assistant row are committed together, so a failure before
 * that commit leaves the messages unclaimed and a BullMQ retry answers them. After the commit the
 * messages stay handled whatever happens: errors mark the assistant row 'error', and if the process
 * dies mid-reply the row is left 'streaming'. A later retry of the same job then finds nothing to
 * claim and is a deliberate no-op (no infinite retries, no duplicate replies); stale 'streaming'
 * rows are excluded from later transcripts, closed as errors by the runs worker's failed handler
 * (job exhausted / stalled) and, as a backstop, by the reaper after CHAT_TURN_STALE_MS.
 */
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

  const turn = await claimTurn(conversationId, emp.id);
  if (!turn) {
    log.debug({ conversationId, userMessageId }, "chat: message already answered in an earlier turn");
    return;
  }
  // From here on the messages are claimed: nothing may throw past this point without closing the turn.
  const { claimed, assistant } = turn;

  /** Close the turn. Never throws: a failed write is logged and retried as a bare status='error'. */
  const finish = async (content: string, status: "done" | "error") => {
    let m: MessageRow | undefined;
    try {
      [m] = await db.update(messages).set({ content, status }).where(eq(messages.id, assistant.id)).returning();
    } catch (e) {
      log.error({ err: e, conversationId, messageId: assistant.id }, "chat: closing the turn failed");
      await db
        .update(messages)
        .set({ status: "error" })
        .where(eq(messages.id, assistant.id))
        .catch((e2: unknown) => log.error({ err: e2, messageId: assistant.id }, "chat: marking the turn as error failed (the reaper closes it)"));
      return;
    }
    if (m) await publishMessage(ws.id, conversationId, m);
  };

  try {
    await publishMessage(ws.id, conversationId, assistant);
    await reply({ ws, emp, conversationId, claimed, assistant, finish });
  } catch (e) {
    const msg = e instanceof MissingCredentialError ? e.message : `Runner error: ${errorMessage(e)}`;
    await finish(`⚠️ ${msg}`, "error");
    await recordStep({ workspaceId: ws.id, conversationId, employeeId: emp.id, kind: "error", name: "runner_error", status: "error", output: msg }).catch((e2: unknown) =>
      log.warn({ err: e2, conversationId }, "chat: runner_error step not recorded"),
    );
  }
}

/** Live update of a chat row; best-effort (the row in the database is the truth, the UI refetches). */
async function publishMessage(workspaceId: string, conversationId: string, m: MessageRow): Promise<void> {
  await publish(workspaceId, { type: "chat.message", conversationId, message: chatMessageDto(m) }).catch((e: unknown) =>
    log.warn({ err: e, conversationId, messageId: m.id }, "chat: publish failed"),
  );
}

async function reply(input: {
  ws: Awaited<ReturnType<typeof getWorkspace>>;
  emp: typeof employees.$inferSelect;
  conversationId: string;
  claimed: MessageRow[];
  assistant: MessageRow;
  finish: (content: string, status: "done" | "error") => Promise<void>;
}): Promise<void> {
  const { ws, emp, conversationId, claimed, assistant, finish } = input;
  if (ws.killSwitch) return finish("⛔ The workspace kill switch is engaged. All employees are stopped.", "error");
  if (emp.status !== "ACTIVE") return finish(`${emp.name} is ${emp.status.toLowerCase().replace("_", " ")} and cannot reply right now.`, "error");

  // The turn's input: every claimed message, in order, each its own paragraph.
  const latestText = claimed.map((m) => m.content).join("\n\n");

  if (ws.demoMode) {
    const text = scriptedChatReply(emp.name, emp.role, latestText);
    let acc = "";
    for (const word of text.split(/(\s+)/)) {
      acc += word;
      await publish(ws.id, { type: "chat.delta", conversationId, messageId: assistant.id, text: word });
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

  const transcript = (await transcriptBefore(conversationId, claimed[0]!.id))
    .map((m) => `${m.role === "user" ? "User" : emp.name}: ${m.content}${m.attachments.length ? ` [attachments: ${m.attachments.map((a) => a.name).join(", ")}]` : ""}`)
    .join("\n\n");
  const attached = attachmentNames(claimed);
  const attach = attached.length
    ? `\n\n(The user attached: ${attached.join(", ")}. Attached documents are indexed in the knowledge base; use kb_search to read them.)`
    : "";
  const prompt = `${transcript ? `Conversation so far:\n${transcript}\n\n---\n` : ""}User: ${latestText}${attach}`;

  const systemPrompt = buildSystemPrompt({
    employee: emp,
    workspaceName: ws.name,
    memories: await recallMemories(emp.id, latestText),
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
    await publish(ws.id, { type: "chat.delta", conversationId, messageId: assistant.id, text });
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
        if (!timer) timer = setTimeout(() => void flush().catch((e: unknown) => log.warn({ err: e, conversationId }, "chat: delta publish failed")), 80);
      },
    });
    if (timer) clearTimeout(timer);
    await flush().catch((e: unknown) => log.warn({ err: e, conversationId }, "chat: delta publish failed"));
    for (const id of ctx.createdTaskIds) await enqueueTask(id, ws.id);
    if (out.stopped === "budget") await pauseForBudget(ws.id, emp.id, "Budget reached during chat");
    let content = out.text || (out.error ? `⚠️ ${out.error}` : "(no reply)");
    if (out.stopped === "quota") {
      const pause = await activeQuotaPause(ws.id);
      content = `${out.text ? `${out.text}\n\n` : ""}⏸️ ${pause?.reason ?? "The Claude subscription limit was reached."}`;
    }
    if (ctx.pendingApprovalIds.length) content += `\n\n🔒 ${ctx.pendingApprovalIds.length} action(s) are waiting in the Approvals inbox.`;
    if (ctx.createdTaskIds.length && ctx.createdTaskIds[0]) {
      await db.update(messages).set({ taskId: ctx.createdTaskIds[0] }).where(eq(messages.id, assistant.id));
    }
    await finish(content, out.stopped === "error" || out.stopped === "quota" ? "error" : "done");
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw e; // runChat marks the turn's reply as an error
  }
}

export async function conversationMessages(conversationId: string) {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id));
}
