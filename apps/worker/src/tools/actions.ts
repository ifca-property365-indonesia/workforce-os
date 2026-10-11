import { approvals, audit, clients, createTask, db, employees, repositories, routines, TaskInputError, teams, users, workspaces, type TaskRow } from "@wfos/db";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { enqueueTask, publish } from "../lib/redis";
import { createPullRequest, pushAgentBranch, type ProviderFetch, type RepoRef } from "../runner/workspace/git";
import { runApprovedCommand } from "../runner/workspace/exec";
import {
  emailPayloadSchema,
  invoicePayloadSchema,
  invoiceTotal,
  ROUTINE_OVERLAP_MODES,
  routineInputSchema,
  webhookPayloadSchema,
  type EmailPayload,
  type InvoicePayload,
} from "@wfos/shared";
import { decryptSecret, withRetry } from "@wfos/shared/server";
import { sendMail } from "@wfos/shared/mail";
import { renderInvoicePdf, formatMoney } from "@wfos/shared/invoice";
import { msg } from "@wfos/shared/messages";
import { and, desc, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getExternalMcpServers, getSmtp, getWebhookUrl, workspaceLocale } from "../lib/settings";

export interface ActionResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function emailHtml(body: string): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.55;color:#18181b;white-space:pre-wrap">${htmlEscape(body)}</div>`;
}

async function doSendEmail(workspaceId: string, p: EmailPayload): Promise<ActionResult> {
  const smtp = await getSmtp(workspaceId);
  if (!smtp) return { ok: false, summary: "SMTP is not configured for this workspace (Settings → Email)." };
  const r = await sendMail(smtp, { to: p.to, cc: p.cc, subject: p.subject, text: p.body, html: p.html ? p.body : emailHtml(p.body) });
  return { ok: true, summary: `Email sent to ${p.to.join(", ")}`, details: { messageId: r.messageId, accepted: r.accepted } };
}

export async function invoiceAttachment(workspaceId: string, p: InvoicePayload, draft: boolean) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const [client] = await db.select().from(clients).where(eq(clients.id, p.clientId));
  const pdf = await renderInvoicePdf(p, {
    workspaceName: ws?.name ?? "Workforce OS",
    clientName: client?.name ?? "Client",
    clientEmail: client?.email,
    draft,
    locale: ws?.defaultLocale,
  });
  return { pdf: Buffer.from(pdf), client, locale: ws?.defaultLocale ?? null };
}

async function doSendInvoice(workspaceId: string, p: InvoicePayload): Promise<ActionResult> {
  const smtp = await getSmtp(workspaceId);
  if (!smtp) return { ok: false, summary: "SMTP is not configured for this workspace (Settings → Email)." };
  const { pdf, client, locale } = await invoiceAttachment(workspaceId, p, false);
  const to = p.to.length ? p.to : client?.email ? [client.email] : [];
  if (!to.length) return { ok: false, summary: "No recipient for invoice" };
  const total = formatMoney(invoiceTotal(p), p.currency, locale === "en" ? "en-US" : "id-ID");
  // defaults in the workspace language; an approved (possibly edited) subject/body is always used as-is
  const subject = p.subject || msg(locale, "invoice.subject", { number: p.invoiceNumber });
  const body = p.body || msg(locale, "invoice.body", { client: client?.name ?? msg(locale, "invoice.client"), number: p.invoiceNumber, total, due: p.dueDate });
  const r = await sendMail(smtp, {
    to,
    subject,
    text: body,
    html: emailHtml(body),
    attachments: [{ filename: `${p.invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  return { ok: true, summary: `Invoice ${p.invoiceNumber} (${total}) sent to ${to.join(", ")}`, details: { messageId: r.messageId } };
}

async function doPostWebhook(workspaceId: string, p: { channel: string; text: string }): Promise<ActionResult> {
  const url = await getWebhookUrl(workspaceId);
  if (!url) return { ok: false, summary: "No webhook configured (Settings → Notifications)." };
  const res = await withRetry(
    async (signal) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: p.text, channel: p.channel }),
        signal,
      });
      if (r.status >= 500) throw new Error(`webhook ${r.status}`);
      return r;
    },
    { retries: 2, timeoutMs: 10000, label: "webhook" },
  );
  return { ok: res.ok, summary: res.ok ? "Published to webhook" : `Webhook responded ${res.status}` };
}

/** Workspace mode: run the exact approved command in the task's sandbox. A non-zero exit is a result, not a platform failure. */
async function doRunApprovedCommand(workspaceId: string, command: string, context: { taskId?: string | null; employeeId?: string | null }): Promise<ActionResult> {
  if (!command || !context.taskId || !context.employeeId) return { ok: false, summary: "Approved command has no task workspace" };
  const [emp] = await db.select({ egress: employees.egressDomains, mode: employees.executionMode }).from(employees).where(eq(employees.id, context.employeeId));
  if (emp?.mode !== "workspace") return { ok: false, summary: "The employee is no longer in Workspace mode" };
  const r = await runApprovedCommand({ workspaceId, taskId: context.taskId, command, egressAllow: emp.egress });
  const status = r.timedOut ? "timed out" : `exit code ${r.exitCode}`;
  return {
    ok: true,
    summary: `Ran in the workspace (${status}), git hooks disabled`,
    details: { exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated, output: r.output },
  };
}

/** Approved PRD → a Developer task carrying the PRD as context, linked to the Project task. */
async function doHandoffPrd(workspaceId: string, p: Record<string, unknown>, context: { taskId?: string | null; untrusted?: boolean }): Promise<ActionResult> {
  const developerId = typeof p.developerId === "string" ? p.developerId : null;
  if (!developerId) return { ok: false, summary: "Choose a developer (Edit & Approve) before approving the handoff." };
  const [dev] = await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.id, developerId), eq(employees.workspaceId, workspaceId)));
  if (!dev) return { ok: false, summary: "The chosen developer does not exist in this workspace." };
  const repositoryId = typeof p.repositoryId === "string" ? p.repositoryId : null;
  const title = String(p.title ?? "PRD").slice(0, 180);
  let t: TaskRow;
  try {
    t = await createTask(db, {
      workspaceId,
      title: `Implement: ${title}`,
      brief: `Implement the approved PRD below. Ask before deviating from its scope or acceptance criteria.

---
${String(p.prd ?? "")}`,
      assigneeId: dev.id,
      originTaskId: context.taskId ?? null,
      repositoryId,
      clientId: typeof p.clientId === "string" ? p.clientId : null,
      projectId: typeof p.projectId === "string" ? p.projectId : null,
      source: "board",
      // the PRD was written by a run that handled untrusted content (the origin link covers an untrusted task)
      untrustedInput: context.untrusted === true,
    });
  } catch (e) {
    if (!(e instanceof TaskInputError)) throw e;
    if (e.code === "repository_not_found") return { ok: false, summary: "The chosen repository does not exist in this workspace." };
    return { ok: false, summary: `The Developer task could not be created: ${e.message}.` };
  }
  await publish(workspaceId, { type: "task.created", taskId: t.id, title: t.title, employeeId: dev.id });
  await enqueueTask(t.id, workspaceId);
  return { ok: true, summary: `Created Developer task "${t.title}" for ${dev.name}`, details: { taskId: t.id } };
}

// ---------------------------------------------------------------------------
// Routines proposed by an employee (propose_routine → approval "create_routine" → created here)
// ---------------------------------------------------------------------------

/** What propose_routine takes, and what an approved create_routine payload must still satisfy. */
export const routineProposalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // the shared rule (exactly 5 fields: minute hour day month weekday), the same one the web's routine form applies
  cron: z.string().trim().pipe(routineInputSchema.shape.cron),
  timezone: z.string().trim().min(1).max(64),
  brief: z.string().trim().min(1).max(20000),
  assigneeId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  overlap: z.enum(ROUTINE_OVERLAP_MODES).optional(),
});
export type RoutineProposal = z.infer<typeof routineProposalSchema>;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next `n` firings of a cron expression in a time zone; throws with a readable message when it is invalid. */
export function cronNextRuns(cron: string, timezone: string, n = 3, from = new Date()): Date[] {
  if (!isTimeZone(timezone)) throw new Error(`Unknown time zone "${timezone}" (use an IANA name such as Asia/Jakarta)`);
  let it;
  try {
    it = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  } catch (e) {
    throw new Error(`Invalid cron expression "${cron}": ${(e as Error).message}`);
  }
  return Array.from({ length: n }, () => it.next().toDate());
}

/** "2026-10-12 09:00 (Asia/Jakarta)": a firing time as people read it in the routine's zone. */
export function formatRunTime(d: Date, timezone: string): string {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${s} (${timezone})`;
}

/**
 * Why a routine's target is refused (null = fine): exactly one of assignee / team, and it must belong to the
 * workspace (the same rule createTask applies to the tasks the routine will create).
 */
export async function routineTargetError(workspaceId: string, assigneeId: string | null | undefined, teamId: string | null | undefined): Promise<string | null> {
  if (assigneeId && teamId) return "Give either an assignee or a team, not both.";
  if (!assigneeId && !teamId) return "Assign the routine to an employee or a team.";
  if (assigneeId) {
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, assigneeId), eq(employees.workspaceId, workspaceId))).limit(1);
    if (!e) return "Unknown employee: the assignee is not an employee of this workspace.";
  }
  if (teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId))).limit(1);
    if (!t) return "Unknown team: the team is not part of this workspace.";
  }
  return null;
}

/** The person who approved the create_routine approval (decided_by), for the audit entry. */
async function approver(workspaceId: string, context: { approvalId?: string | null; employeeId?: string | null }): Promise<{ id: string; email: string } | null> {
  const where = context.approvalId
    ? and(eq(approvals.id, context.approvalId), eq(approvals.workspaceId, workspaceId))
    : // executeApproval has claimed the row (EXECUTING) before it calls executeAction
      and(eq(approvals.workspaceId, workspaceId), eq(approvals.toolName, "create_routine"), eq(approvals.status, "EXECUTING"), context.employeeId ? eq(approvals.employeeId, context.employeeId) : undefined);
  const [a] = await db.select({ decidedBy: approvals.decidedBy }).from(approvals).where(where).orderBy(desc(approvals.decidedAt)).limit(1);
  if (!a?.decidedBy) return null;
  const [u] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, a.decidedBy));
  return u ?? null;
}

/**
 * Approved create_routine: re-validate the (possibly edited) payload, then create the routine enabled. A routine
 * proposed by a tainted run (`context.untrusted`, read from the run's own payload) is marked untrustedInput: a
 * person approved it, but its brief came from untrusted content, so every task it creates starts tainted.
 */
async function doCreateRoutine(
  workspaceId: string,
  payload: Record<string, unknown>,
  context: { approvalId?: string | null; employeeId?: string | null; untrusted?: boolean },
): Promise<ActionResult> {
  const parsed = routineProposalSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, summary: `Invalid routine: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}` };
  const p = parsed.data;
  let next: Date;
  try {
    next = cronNextRuns(p.cron, p.timezone, 1)[0]!;
  } catch (e) {
    return { ok: false, summary: (e as Error).message };
  }
  const refused = await routineTargetError(workspaceId, p.assigneeId, p.teamId);
  if (refused) return { ok: false, summary: refused };
  const [r] = await db
    .insert(routines)
    .values({
      workspaceId,
      name: p.name,
      cron: p.cron,
      timezone: p.timezone,
      brief: p.brief,
      assigneeId: p.assigneeId ?? null,
      teamId: p.teamId ?? null,
      overlap: p.overlap ?? "skip",
      enabled: true,
      untrustedInput: context.untrusted === true,
      nextRunAt: next,
    })
    .returning();
  const who = await approver(workspaceId, context);
  await audit({
    workspaceId,
    actorUserId: who?.id ?? null,
    actorLabel: who?.email ?? "approval",
    action: "routine.created",
    targetType: "routine",
    targetId: r!.id,
    details: { cron: r!.cron, name: r!.name, timezone: r!.timezone, proposedBy: context.employeeId ?? null, approvalId: context.approvalId ?? null, untrustedInput: r!.untrustedInput },
  });
  const locale = await workspaceLocale(workspaceId);
  return { ok: true, summary: msg(locale, "routine.created", { name: r!.name, next: formatRunTime(next, r!.timezone) }), details: { routineId: r!.id, nextRunAt: next.toISOString() } };
}

async function repoFor(workspaceId: string, repositoryId: unknown): Promise<(RepoRef & { name: string }) | null> {
  if (typeof repositoryId !== "string") return null;
  const [r] = await db.select().from(repositories).where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)));
  if (!r) return null;
  return { id: r.id, name: r.name, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, token: r.tokenEnc ? decryptSecret(r.tokenEnc) : null };
}

/** Push exactly the approved commit (payload.head) from the platform mirror. */
async function doGitPush(workspaceId: string, p: Record<string, unknown>, context: { taskId?: string | null }): Promise<ActionResult> {
  const repo = await repoFor(workspaceId, p.repositoryId);
  if (!repo || !context.taskId) return { ok: false, summary: "Repository not found" };
  const r = await pushAgentBranch(repo, context.taskId, String(p.head ?? ""));
  return { ok: r.ok, summary: r.summary, details: { branch: p.branch, head: p.head } };
}

async function doCreatePullRequest(workspaceId: string, p: Record<string, unknown>): Promise<ActionResult> {
  const repo = await repoFor(workspaceId, p.repositoryId);
  if (!repo) return { ok: false, summary: "Repository not found" };
  const r = await createPullRequest(repo, { taskId: String(p.taskId), title: String(p.title ?? ""), body: String(p.body ?? ""), base: String(p.base ?? repo.defaultBranch) }, providerFetch());
  return { ok: r.ok, summary: r.summary, details: { url: r.url } };
}

/** Provider HTTP client (swappable in tests: no real GitHub/GitLab calls). */
let providerFetchImpl: ProviderFetch | null = null;
export function setProviderFetch(f: ProviderFetch | null): void {
  providerFetchImpl = f;
}
function providerFetch(): ProviderFetch {
  return providerFetchImpl ?? (fetch as unknown as ProviderFetch);
}

/** fetch for the MCP transport that never lets the runtime follow a redirect (redirectPolicy "same-origin" decides). */
export const noAutoRedirectFetch: FetchLike = (url, init) => fetch(url, { ...init, redirect: "manual" });

export async function callExternalMcpTool(workspaceId: string, server: string, tool: string, args: Record<string, unknown>): Promise<ActionResult> {
  const servers = await getExternalMcpServers(workspaceId);
  const s = servers.find((x) => x.name === server);
  if (!s) return { ok: false, summary: `MCP server ${server} not connected` };
  const client = new Client({ name: "workforce-os", version: "0.1.0" });
  // the runtime never follows a redirect by itself; the SDK follows one only within the server's origin, so the
  // auth header is never sent to a host it was not configured for (same as apps/web/src/lib/server/mcp.ts)
  const transport = new StreamableHTTPClientTransport(new URL(s.url), {
    requestInit: { headers: s.headers },
    redirectPolicy: "same-origin",
    fetch: noAutoRedirectFetch,
  });
  try {
    await withRetry(() => client.connect(transport), { retries: 1, timeoutMs: 15000, label: "mcp-connect" });
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    const text = Array.isArray(r.content)
      ? r.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
      : JSON.stringify(r);
    return { ok: !r.isError, summary: text.slice(0, 2000) };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Execute an irreversible action with its exact (possibly human-edited) payload.
 * Only called after the gate said "run" or a human approved.
 */
export async function executeAction(
  workspaceId: string,
  toolName: string,
  payload: Record<string, unknown>,
  /**
   * untrusted: the run that asked for this action was tainted (approval payload untrustedInput);
   * approvalId: the approval being executed (create_routine audits its approver)
   */
  context: { taskId?: string | null; employeeId?: string | null; untrusted?: boolean; approvalId?: string | null } = {},
): Promise<ActionResult> {
  switch (toolName) {
    case "bash":
      return doRunApprovedCommand(workspaceId, String(payload.command ?? ""), context);
    case "handoff_prd":
      return doHandoffPrd(workspaceId, payload, context);
    case "git_push":
      return doGitPush(workspaceId, payload, context);
    case "create_pull_request":
      return doCreatePullRequest(workspaceId, payload);
    case "send_email":
      return doSendEmail(workspaceId, emailPayloadSchema.parse(payload));
    case "send_invoice":
      return doSendInvoice(workspaceId, invoicePayloadSchema.parse(payload));
    case "post_webhook":
      return doPostWebhook(workspaceId, webhookPayloadSchema.parse(payload));
    case "create_routine":
      return doCreateRoutine(workspaceId, payload, context);
    default: {
      if (toolName.startsWith("mcp__")) {
        const [, server, ...rest] = toolName.split("__");
        return callExternalMcpTool(workspaceId, server!, rest.join("__"), payload);
      }
      return { ok: false, summary: `Unknown irreversible tool ${toolName}` };
    }
  }
}
