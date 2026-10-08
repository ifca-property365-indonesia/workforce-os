import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentMessages,
  approvals,
  chunks,
  clients,
  db,
  documents,
  employees,
  memories,
  projects,
  tasks,
  teamMembers,
  type Deliverable,
} from "@wfos/db";
import {
  TOOL_BY_NAME,
  applyRunSignals,
  classifyTool,
  decideGate,
  emailPayloadSchema,
  invoicePayloadSchema,
  invoiceTotal,
  webhookPayloadSchema,
  type AllowListEntry,
  type AutonomyLevel,
  type GateDecision,
  type ToolPermission,
} from "@wfos/shared";
import { withRetry } from "@wfos/shared/server";
import { safeFetch, SsrfBlockedError, type SafeFetchResult } from "@wfos/shared/netguard";
import { embedOne, toVectorLiteral } from "../lib/embeddings";
import { recordStep } from "../lib/steps";
import { publish, miscQueue } from "../lib/redis";
import { guardOutput, guardToolResult, type GuardCtx } from "../guards/content";
import { executeAction } from "./actions";
import { log } from "../lib/logger";

export const WFOS_SERVER = "wfos";

export interface TeamContext {
  teamId: string;
  role: "lead" | "member";
  phase: "plan" | "review" | "work";
  memberIds: string[];
}

export interface RunContext {
  runId: string;
  workspaceId: string;
  employee: {
    id: string;
    name: string;
    role: string;
    autonomyLevel: AutonomyLevel;
    toolPermissions: ToolPermission[];
    allowList: AllowListEntry[];
  };
  taskId: string | null;
  conversationId: string | null;
  dryRun: boolean;
  /** demo/replay runs never create approvals or real side effects */
  sandboxed: boolean;
  guard: GuardCtx;
  pendingApprovalIds: string[];
  deliverables: Deliverable[];
  createdTaskIds: string[];
  delegatedTaskIds: string[];
  revisionRequests: { taskId: string; feedback: string }[];
  team?: TeamContext;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function toolCredits(name: string): number {
  return TOOL_BY_NAME[name]?.credits ?? 0.1;
}

/** Team tools are granted implicitly by the orchestration context, not by permissions. */
function effectivePermissions(ctx: RunContext): ToolPermission[] {
  const perms = [...ctx.employee.toolPermissions];
  if (ctx.team?.role === "lead") {
    for (const t of ["delegate_subtask", "request_revision", "message_teammate", "list_tasks"]) {
      if (!perms.some((p) => p.tool === t)) perms.push({ tool: t, enabled: true });
    }
  }
  if (ctx.team && !perms.some((p) => p.tool === "message_teammate")) perms.push({ tool: "message_teammate", enabled: true });
  return perms;
}

/**
 * Wrap a tool handler: enforce gate, time it, guard it, and record an Activity step.
 */
function wrap<A extends Record<string, unknown>>(
  ctx: RunContext,
  name: string,
  handler: (args: A, decision: GateDecision) => Promise<ToolResult>,
) {
  return async (args: A): Promise<ToolResult> => {
    const started = Date.now();
    const cls = classifyTool(name);
    // Reversible tools: gate only checks the grant. Irreversible tools gate inside their handler
    // because the scope (recipients, client, amount) comes from the validated payload.
    const decision: GateDecision =
      cls === "reversible"
        ? decideGate({
            toolName: name,
            toolClass: cls,
            employeeAutonomy: ctx.employee.autonomyLevel,
            permissions: effectivePermissions(ctx),
            allowList: ctx.employee.allowList,
            dryRun: ctx.dryRun,
          })
        : { kind: "run" };
    let result: ToolResult;
    if (decision.kind === "deny") {
      result = err(decision.reason);
    } else {
      try {
        result = await handler(args, decision);
      } catch (e) {
        log.warn({ err: e, tool: name }, "tool failed");
        result = err(`Tool ${name} failed: ${(e as Error).message}`);
      }
    }
    await recordStep({
      workspaceId: ctx.workspaceId,
      taskId: ctx.taskId,
      conversationId: ctx.conversationId,
      employeeId: ctx.employee.id,
      kind: "tool",
      name,
      latencyMs: Date.now() - started,
      credits: result.isError ? 0 : toolCredits(name),
      input: args,
      output: result.content.map((c) => c.text).join("\n").slice(0, 8000),
      status: decision.kind === "deny" ? "denied" : result.isError ? "error" : "ok",
    });
    return result;
  };
}

async function addDeliverable(ctx: RunContext, d: Omit<Deliverable, "id" | "createdAt">): Promise<Deliverable> {
  // Diff vs the previous version with the same title in this task (or the parent's deliverables).
  let previous: Deliverable | undefined = [...ctx.deliverables].reverse().find((x) => x.title === d.title);
  if (!previous && ctx.taskId) {
    const [t] = await db.select({ deliverables: tasks.deliverables }).from(tasks).where(eq(tasks.id, ctx.taskId));
    previous = [...(t?.deliverables ?? [])].reverse().find((x) => x.title === d.title);
  }
  const deliverable: Deliverable = {
    ...d,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    diff: previous ? createTwoFilesPatch(`${d.title} (previous)`, `${d.title} (new)`, previous.content, d.content) : d.diff,
  };
  ctx.deliverables.push(deliverable);
  if (ctx.taskId) {
    await db
      .update(tasks)
      .set({ deliverables: sql`${tasks.deliverables} || ${JSON.stringify([deliverable])}::jsonb` })
      .where(eq(tasks.id, ctx.taskId));
  }
  return deliverable;
}

export async function createApproval(
  ctx: RunContext,
  toolName: string,
  title: string,
  reason: string,
  payload: Record<string, unknown>,
  guardFindings: unknown[],
): Promise<string> {
  const [a] = await db
    .insert(approvals)
    .values({
      workspaceId: ctx.workspaceId,
      taskId: ctx.taskId,
      employeeId: ctx.employee.id,
      toolName,
      title,
      reason,
      payload,
      guardFindings,
    })
    .returning();
  ctx.pendingApprovalIds.push(a!.id);
  await recordStep({
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    conversationId: ctx.conversationId,
    employeeId: ctx.employee.id,
    kind: "approval",
    name: `approval_requested:${toolName}`,
    status: "pending",
    input: { approvalId: a!.id, reason },
    output: payload,
  });
  await publish(ctx.workspaceId, { type: "approval.created", approvalId: a!.id, taskId: ctx.taskId, title });
  await miscQueue.add("notify", {
    kind: "notify",
    workspaceId: ctx.workspaceId,
    subject: `Approval needed: ${title}`,
    text: `${ctx.employee.name} (${ctx.employee.role}) wants to run ${toolName}.\nReason: ${reason}`,
    link: `/approvals?focus=${a!.id}`,
  });
  return a!.id;
}

/**
 * Shared path for every irreversible action: validate → output guard → gate → run / draft / simulate / approval.
 */
async function irreversible(
  ctx: RunContext,
  toolName: string,
  payload: Record<string, unknown>,
  meta: { title: string; textForGuard: string; scope: { recipients?: string[]; clientId?: string | null; amount?: number }; draftKind: Deliverable["kind"]; draftContent: string },
): Promise<ToolResult> {
  const { findings } = await guardOutput(ctx.guard, `${toolName} payload`, meta.textForGuard);
  const highLeak = findings.some((f) => f.severity === "high");
  const decision = applyRunSignals(
    decideGate({
      toolName,
      toolClass: "irreversible",
      employeeAutonomy: ctx.employee.autonomyLevel,
      permissions: effectivePermissions(ctx),
      allowList: ctx.employee.allowList,
      dryRun: ctx.dryRun || ctx.sandboxed,
      scope: meta.scope,
    }),
    { toolClass: "irreversible", tainted: ctx.guard.tainted, highLeak },
  );

  switch (decision.kind) {
    case "deny":
      return err(decision.reason);
    case "simulate": {
      await addDeliverable(ctx, {
        kind: "simulated_action",
        title: `[DRY RUN] ${meta.title}`,
        content: meta.draftContent,
        meta: { toolName, payload, wouldHave: `would have executed ${toolName}` },
      });
      await recordStep({
        workspaceId: ctx.workspaceId,
        taskId: ctx.taskId,
        conversationId: ctx.conversationId,
        employeeId: ctx.employee.id,
        kind: "tool",
        name: `simulated:${toolName}`,
        status: "simulated",
        input: payload,
        output: { note: decision.reason },
      });
      return ok(`DRY RUN: ${toolName} was NOT executed. Recorded what would have happened: "${meta.title}". Treat it as done for this simulation.`);
    }
    case "draft": {
      await addDeliverable(ctx, { kind: meta.draftKind, title: meta.title, content: meta.draftContent, meta: { toolName, payload } });
      return ok(`${decision.reason} Draft saved as deliverable "${meta.title}". Tell the user it was drafted, not sent.`);
    }
    case "approval": {
      const id = await createApproval(ctx, toolName, meta.title, decision.reason, payload, findings);
      return ok(
        `Queued for human approval (approval id ${id}). The action has NOT been executed yet. ` +
          `Do not call ${toolName} again for this same action. Continue with any other work, then finish with a short summary that mentions the pending approval.`,
      );
    }
    case "run": {
      const r = await executeAction(ctx.workspaceId, toolName, payload);
      return r.ok ? ok(r.summary) : err(r.summary);
    }
  }
}

function extractRecipients(p: { to?: string[]; cc?: string[] }): string[] {
  return [...(p.to ?? []), ...(p.cc ?? [])];
}

const toolDefs = new WeakMap<object, SdkMcpToolDefinition[]>();

export function buildToolServer(ctx: RunContext) {
  const tools = buildTools(ctx);
  const server = createSdkMcpServer({ name: WFOS_SERVER, version: "0.1.0", tools, alwaysLoad: true, timeout: 120_000 });
  toolDefs.set(server, tools);
  return server;
}

/** Tool definitions behind a server built by buildToolServer (used by the mock runner). */
export function toolDefsOf(server: unknown): SdkMcpToolDefinition[] | undefined {
  return typeof server === "object" && server ? toolDefs.get(server) : undefined;
}

/** The tool definitions granted to this run (exported for tests and the SDK server). */
export function buildTools(ctx: RunContext) {
  const granted = new Set(effectivePermissions(ctx).filter((p) => p.enabled).map((p) => p.tool));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defs: SdkMcpToolDefinition<any>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (name: string, def: SdkMcpToolDefinition<any>) => {
    if (granted.has(name)) defs.push(def);
  };

  add(
    "kb_search",
    tool(
      "kb_search",
      "Search the workspace knowledge base (uploaded PDF/DOCX/MD). Returns passages with citation labels like [Doc name §3]. Cite them in answers.",
      { query: z.string().min(2), limit: z.number().int().min(1).max(10).optional() },
      wrap(ctx, "kb_search", async (a: { query: string; limit?: number }) => {
        const v = toVectorLiteral(await embedOne(a.query));
        const rows = await db
          .select({ content: chunks.content, ordinal: chunks.ordinal, doc: documents.name, dist: sql<number>`${chunks.embedding} <=> ${v}::vector` })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(eq(chunks.workspaceId, ctx.workspaceId))
          .orderBy(sql`${chunks.embedding} <=> ${v}::vector`)
          .limit(a.limit ?? 5);
        if (!rows.length) return ok("No knowledge base passages found. The knowledge base may be empty.");
        const text = rows.map((r) => `[${r.doc} §${r.ordinal + 1}] (relevance ${(1 - r.dist).toFixed(2)})\n${r.content}`).join("\n\n---\n\n");
        return ok(await guardToolResult(ctx.guard, "knowledge base", text));
      }),
    ),
  );

  add(
    "memory_search",
    tool(
      "memory_search",
      "Search your own long-term memory (facts learned, past feedback from reviewers).",
      { query: z.string().min(2) },
      wrap(ctx, "memory_search", async (a: { query: string }) => {
        const v = toVectorLiteral(await embedOne(a.query));
        const rows = await db
          .select({ content: memories.content, kind: memories.kind, at: memories.createdAt })
          .from(memories)
          .where(eq(memories.employeeId, ctx.employee.id))
          .orderBy(sql`${memories.embedding} <=> ${v}::vector`)
          .limit(6);
        return ok(rows.length ? rows.map((r) => `- (${r.kind}, ${r.at.toISOString().slice(0, 10)}) ${r.content}`).join("\n") : "No memories yet.");
      }),
    ),
  );

  add(
    "memory_save",
    tool(
      "memory_save",
      "Save a durable fact or preference to your long-term memory (e.g. 'Client X prefers Bahasa Indonesia'). Never store secrets.",
      { content: z.string().min(3).max(1000), kind: z.enum(["fact", "preference"]).optional() },
      wrap(ctx, "memory_save", async (a: { content: string; kind?: "fact" | "preference" }) => {
        const { text, findings } = await guardOutput(ctx.guard, "memory_save", a.content);
        if (findings.some((f) => f.severity === "high")) return err("Refused: memory content looks like it contains a secret.");
        const v = await embedOne(text);
        await db.insert(memories).values({ workspaceId: ctx.workspaceId, employeeId: ctx.employee.id, kind: a.kind ?? "fact", content: text, source: "agent", embedding: v });
        return ok("Saved to memory.");
      }),
    ),
  );

  add(
    "list_clients",
    tool(
      "list_clients",
      "List clients with their ids, emails and projects.",
      {},
      wrap(ctx, "list_clients", async () => {
        const cs = await db.select().from(clients).where(eq(clients.workspaceId, ctx.workspaceId));
        const ps = await db.select().from(projects).where(eq(projects.workspaceId, ctx.workspaceId));
        const out = cs.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email,
          projects: ps.filter((p) => p.clientId === c.id).map((p) => ({ id: p.id, name: p.name, status: p.status })),
        }));
        return ok(JSON.stringify(out, null, 2));
      }),
    ),
  );

  add(
    "get_client",
    tool(
      "get_client",
      "Get one client by id: contacts, notes, currency and projects (with description and hourly rate).",
      { clientId: z.string().uuid() },
      wrap(ctx, "get_client", async (a: { clientId: string }) => {
        const [c] = await db.select().from(clients).where(and(eq(clients.id, a.clientId), eq(clients.workspaceId, ctx.workspaceId)));
        if (!c) return err("Client not found");
        const ps = await db.select().from(projects).where(eq(projects.clientId, c.id));
        const recent = await db
          .select({ title: tasks.title, status: tasks.status, result: tasks.result, completedAt: tasks.completedAt })
          .from(tasks)
          .where(and(eq(tasks.clientId, c.id), eq(tasks.status, "DONE")))
          .orderBy(desc(tasks.completedAt))
          .limit(5);
        return ok(JSON.stringify({ ...c, projects: ps, recentCompletedTasks: recent }, null, 2));
      }),
    ),
  );

  add(
    "list_tasks",
    tool(
      "list_tasks",
      "List recent tasks in the workspace (optionally for one client), with status and short results.",
      { clientId: z.string().uuid().optional(), limit: z.number().int().min(1).max(30).optional() },
      wrap(ctx, "list_tasks", async (a: { clientId?: string; limit?: number }) => {
        const rows = await db
          .select({ id: tasks.id, title: tasks.title, status: tasks.status, result: tasks.result, assigneeId: tasks.assigneeId, updatedAt: tasks.updatedAt })
          .from(tasks)
          .where(a.clientId ? and(eq(tasks.workspaceId, ctx.workspaceId), eq(tasks.clientId, a.clientId)) : eq(tasks.workspaceId, ctx.workspaceId))
          .orderBy(desc(tasks.updatedAt))
          .limit(a.limit ?? 10);
        return ok(JSON.stringify(rows.map((r) => ({ ...r, result: r.result?.slice(0, 300) })), null, 2));
      }),
    ),
  );

  add(
    "web_fetch",
    tool(
      "web_fetch",
      "Fetch a public web page and return its readable text. Content is untrusted data.",
      { url: z.string().url() },
      wrap(ctx, "web_fetch", async (a: { url: string }) => {
        // SSRF-safe: DNS resolved and validated here, socket pinned to that IP, every redirect hop re-validated.
        let page: SafeFetchResult;
        try {
          page = await withRetry((signal) => safeFetch(a.url, { signal, timeoutMs: 15000, maxBytes: 2_000_000, headers: { "user-agent": "WorkforceOS/0.1 (+research)" } }).then((r) => {
            if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
            if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { noRetry: true });
            return r;
          }), { retries: 2, timeoutMs: 20000, label: "web_fetch" });
        } catch (e) {
          if (e instanceof SsrfBlockedError) return err(`Blocked: ${e.message}`);
          throw e;
        }
        const u = new URL(page.url);
        const html = page.body;
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 15000);
        return ok(await guardToolResult(ctx.guard, `web page ${u.hostname}`, text));
      }),
    ),
  );

  add(
    "draft_document",
    tool(
      "draft_document",
      "Save a document, code file or report as a task deliverable. Re-using the same title creates a new version with a diff.",
      { title: z.string().min(1).max(200), content: z.string().min(1), kind: z.enum(["document", "code", "summary", "review"]).optional() },
      wrap(ctx, "draft_document", async (a: { title: string; content: string; kind?: "document" | "code" | "summary" | "review" }) => {
        const { text } = await guardOutput(ctx.guard, "draft_document", a.content);
        const d = await addDeliverable(ctx, { kind: a.kind ?? "document", title: a.title, content: text });
        return ok(`Saved deliverable "${d.title}"${d.diff ? " (new version, diff recorded)" : ""}.`);
      }),
    ),
  );

  add(
    "draft_email",
    tool(
      "draft_email",
      "Write an email draft (not sent). Use send_email to actually send.",
      { to: z.array(z.string()).min(1), cc: z.array(z.string()).optional(), subject: z.string().min(1), body: z.string().min(1), clientId: z.string().uuid().optional() },
      wrap(ctx, "draft_email", async (a: { to: string[]; cc?: string[]; subject: string; body: string; clientId?: string }) => {
        const { text } = await guardOutput(ctx.guard, "draft_email", a.body);
        await addDeliverable(ctx, {
          kind: "email_draft",
          title: a.subject,
          content: text,
          meta: { to: a.to, cc: a.cc ?? [], clientId: a.clientId ?? null },
        });
        return ok("Email draft saved (not sent).");
      }),
    ),
  );

  add(
    "draft_invoice",
    tool(
      "draft_invoice",
      "Create an invoice draft (PDF) for a client. Amounts in the client's currency. Not sent.",
      {
        clientId: z.string().uuid(),
        invoiceNumber: z.string().min(3),
        currency: z.string().optional(),
        lines: z.array(z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() })).min(1),
        dueDate: z.string(),
        notes: z.string().optional(),
      },
      wrap(ctx, "draft_invoice", async (a: Record<string, unknown>) => {
        const inv = invoicePayloadSchema.parse(a);
        const total = invoiceTotal(inv);
        await addDeliverable(ctx, {
          kind: "invoice",
          title: `Invoice ${inv.invoiceNumber}`,
          content: inv.lines.map((l) => `${l.description} — ${l.quantity} × ${l.unitPrice}`).join("\n") + `\nTotal: ${inv.currency} ${total}`,
          meta: { invoice: inv, total },
        });
        return ok(`Invoice draft ${inv.invoiceNumber} saved. Total ${inv.currency} ${total}.`);
      }),
    ),
  );

  add(
    "create_task",
    tool(
      "create_task",
      "Create a task on the task board for yourself or another employee (by id).",
      { title: z.string().min(1).max(200), brief: z.string().min(1), assigneeId: z.string().uuid().optional(), clientId: z.string().uuid().optional(), start: z.boolean().optional() },
      wrap(ctx, "create_task", async (a: { title: string; brief: string; assigneeId?: string; clientId?: string; start?: boolean }) => {
        const [t] = await db
          .insert(tasks)
          .values({
            workspaceId: ctx.workspaceId,
            title: a.title,
            brief: a.brief,
            assigneeId: a.assigneeId ?? ctx.employee.id,
            clientId: a.clientId ?? null,
            source: ctx.conversationId ? "chat" : "board",
            status: "QUEUED",
            dryRun: ctx.dryRun,
            phase: a.start === false ? "hold" : null,
          })
          .returning();
        ctx.createdTaskIds.push(t!.id);
        await publish(ctx.workspaceId, { type: "task.created", taskId: t!.id, title: t!.title, employeeId: t!.assigneeId });
        return ok(`Task created (id ${t!.id}). It will appear on the board${a.start === false ? " (not started)" : " and start shortly"}.`);
      }),
    ),
  );

  add(
    "delegate_subtask",
    tool(
      "delegate_subtask",
      "Team lead only: assign a bounded subtask to a team member (employee id). The parent task waits until all subtasks finish, then you review.",
      { assigneeId: z.string().uuid(), title: z.string().min(1).max(200), brief: z.string().min(1), acceptanceCriteria: z.string().optional() },
      wrap(ctx, "delegate_subtask", async (a: { assigneeId: string; title: string; brief: string; acceptanceCriteria?: string }) => {
        if (!ctx.team || ctx.team.role !== "lead" || ctx.team.phase !== "plan") return err("delegate_subtask is only available to a team lead while planning.");
        if (!ctx.team.memberIds.includes(a.assigneeId)) return err("Assignee is not a member of this team.");
        const [parent] = ctx.taskId ? await db.select().from(tasks).where(eq(tasks.id, ctx.taskId)) : [];
        const [t] = await db
          .insert(tasks)
          .values({
            workspaceId: ctx.workspaceId,
            title: a.title,
            brief: a.acceptanceCriteria ? `${a.brief}\n\nAcceptance criteria:\n${a.acceptanceCriteria}` : a.brief,
            assigneeId: a.assigneeId,
            parentTaskId: ctx.taskId,
            teamId: ctx.team.teamId,
            clientId: parent?.clientId ?? null,
            projectId: parent?.projectId ?? null,
            source: "team",
            status: "QUEUED",
            dryRun: ctx.dryRun,
          })
          .returning();
        ctx.delegatedTaskIds.push(t!.id);
        await db.insert(agentMessages).values({
          workspaceId: ctx.workspaceId,
          taskId: t!.id,
          fromEmployeeId: ctx.employee.id,
          toEmployeeId: a.assigneeId,
          intent: "request",
          content: `New subtask: ${a.title}`,
        });
        await publish(ctx.workspaceId, { type: "task.created", taskId: t!.id, parentTaskId: ctx.taskId, title: t!.title, employeeId: a.assigneeId });
        return ok(`Subtask "${a.title}" delegated (id ${t!.id}).`);
      }),
    ),
  );

  add(
    "request_revision",
    tool(
      "request_revision",
      "Team lead only, during review: send a subtask back to its assignee with specific feedback (max once per subtask).",
      { subtaskId: z.string().uuid(), feedback: z.string().min(5) },
      wrap(ctx, "request_revision", async (a: { subtaskId: string; feedback: string }) => {
        if (!ctx.team || ctx.team.role !== "lead" || ctx.team.phase !== "review") return err("request_revision is only available to a team lead during review.");
        ctx.revisionRequests.push({ taskId: a.subtaskId, feedback: a.feedback });
        return ok("Revision requested. The parent task will wait for the revised deliverable, then you review again.");
      }),
    ),
  );

  add(
    "message_teammate",
    tool(
      "message_teammate",
      "Send a structured message to another employee in the workspace (they see it on their next run).",
      { toEmployeeId: z.string().uuid(), intent: z.enum(["request", "update", "question", "answer", "review"]), content: z.string().min(1).max(4000) },
      wrap(ctx, "message_teammate", async (a: { toEmployeeId: string; intent: string; content: string }) => {
        const [to] = await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.id, a.toEmployeeId), eq(employees.workspaceId, ctx.workspaceId)));
        if (!to) return err("Unknown employee id");
        const { text } = await guardOutput(ctx.guard, "message_teammate", a.content);
        await db.insert(agentMessages).values({ workspaceId: ctx.workspaceId, taskId: ctx.taskId, fromEmployeeId: ctx.employee.id, toEmployeeId: to.id, intent: a.intent, content: text });
        await recordStep({
          workspaceId: ctx.workspaceId,
          taskId: ctx.taskId,
          conversationId: ctx.conversationId,
          employeeId: ctx.employee.id,
          kind: "agent_message",
          name: `${ctx.employee.name} → ${to.name}`,
          input: { intent: a.intent },
          output: text,
        });
        return ok(`Message delivered to ${to.name}.`);
      }),
    ),
  );

  // ---- irreversible ----
  add(
    "send_email",
    tool(
      "send_email",
      "Send an email. IRREVERSIBLE: depending on your autonomy it is drafted, queued for human approval, or sent. Use addresses from client master data.",
      { to: z.array(z.string()).min(1), cc: z.array(z.string()).optional(), subject: z.string().min(1), body: z.string().min(1), clientId: z.string().uuid().optional() },
      wrap(ctx, "send_email", async (a: Record<string, unknown>) => {
        const p = emailPayloadSchema.parse(a);
        return irreversible(ctx, "send_email", p, {
          title: `Email: ${p.subject} → ${p.to.join(", ")}`,
          textForGuard: `${p.subject}\n${p.body}`,
          scope: { recipients: extractRecipients(p), clientId: p.clientId ?? null },
          draftKind: "email_draft",
          draftContent: `To: ${p.to.join(", ")}\n${p.cc.length ? `Cc: ${p.cc.join(", ")}\n` : ""}Subject: ${p.subject}\n\n${p.body}`,
        });
      }),
    ),
  );

  add(
    "send_invoice",
    tool(
      "send_invoice",
      "Email an invoice PDF to a client. IRREVERSIBLE: drafted, queued for approval, or sent depending on autonomy.",
      {
        clientId: z.string().uuid(),
        invoiceNumber: z.string().min(3),
        currency: z.string().optional(),
        lines: z.array(z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() })).min(1),
        dueDate: z.string(),
        notes: z.string().optional(),
        to: z.array(z.string()).optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
      },
      wrap(ctx, "send_invoice", async (a: Record<string, unknown>) => {
        const p = invoicePayloadSchema.parse(a);
        const total = invoiceTotal(p);
        return irreversible(ctx, "send_invoice", p, {
          title: `Invoice ${p.invoiceNumber} (${p.currency} ${total})`,
          textForGuard: `${p.subject}\n${p.body}\n${p.notes}`,
          scope: { recipients: p.to, clientId: p.clientId, amount: total },
          draftKind: "invoice",
          draftContent: p.lines.map((l) => `${l.description} — ${l.quantity} × ${l.unitPrice}`).join("\n") + `\nTotal: ${p.currency} ${total}`,
        });
      }),
    ),
  );

  add(
    "post_webhook",
    tool(
      "post_webhook",
      "Publish a message to the workspace webhook (Slack/Telegram/WhatsApp gateway). IRREVERSIBLE.",
      { text: z.string().min(1).max(4000), channel: z.string().optional() },
      wrap(ctx, "post_webhook", async (a: Record<string, unknown>) => {
        const p = webhookPayloadSchema.parse(a);
        return irreversible(ctx, "post_webhook", p, {
          title: `Publish: ${p.text.slice(0, 60)}`,
          textForGuard: p.text,
          scope: {},
          draftKind: "document",
          draftContent: p.text,
        });
      }),
    ),
  );

  return defs;
}

/** Tool names (as the SDK sees them) for the in-process server. */
export function grantedToolNames(ctx: RunContext): string[] {
  return effectivePermissions(ctx)
    .filter((p) => p.enabled && TOOL_BY_NAME[p.tool])
    .map((p) => `mcp__${WFOS_SERVER}__${p.tool}`);
}

export async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await db.select({ id: teamMembers.employeeId }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
  return rows.map((r) => r.id);
}

export async function unreadMessagesFor(employeeId: string) {
  const rows = await db
    .select({ id: agentMessages.id, from: employees.name, fromId: agentMessages.fromEmployeeId, intent: agentMessages.intent, content: agentMessages.content, at: agentMessages.createdAt })
    .from(agentMessages)
    .leftJoin(employees, eq(employees.id, agentMessages.fromEmployeeId))
    .where(and(eq(agentMessages.toEmployeeId, employeeId), sql`${agentMessages.readAt} is null`))
    .orderBy(agentMessages.createdAt)
    .limit(20);
  if (rows.length) {
    await db.update(agentMessages).set({ readAt: new Date() }).where(inArray(agentMessages.id, rows.map((r) => r.id)));
  }
  return rows;
}
