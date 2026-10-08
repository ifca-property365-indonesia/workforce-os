import { clients, db, employees, repositories, workspaces } from "@wfos/db";
import { createPullRequest, pushAgentBranch, type ProviderFetch, type RepoRef } from "../runner/workspace/git";
import { runApprovedCommand } from "../runner/workspace/exec";
import {
  emailPayloadSchema,
  invoicePayloadSchema,
  invoiceTotal,
  webhookPayloadSchema,
  type EmailPayload,
  type InvoicePayload,
} from "@wfos/shared";
import { decryptSecret, withRetry } from "@wfos/shared/server";
import { sendMail } from "@wfos/shared/mail";
import { renderInvoicePdf, formatMoney } from "@wfos/shared/invoice";
import { msg } from "@wfos/shared/messages";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getExternalMcpServers, getSmtp, getWebhookUrl } from "../lib/settings";

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

export async function callExternalMcpTool(workspaceId: string, server: string, tool: string, args: Record<string, unknown>): Promise<ActionResult> {
  const servers = await getExternalMcpServers(workspaceId);
  const s = servers.find((x) => x.name === server);
  if (!s) return { ok: false, summary: `MCP server ${server} not connected` };
  const client = new Client({ name: "workforce-os", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers } });
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
  context: { taskId?: string | null; employeeId?: string | null } = {},
): Promise<ActionResult> {
  switch (toolName) {
    case "bash":
      return doRunApprovedCommand(workspaceId, String(payload.command ?? ""), context);
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
    default: {
      if (toolName.startsWith("mcp__")) {
        const [, server, ...rest] = toolName.split("__");
        return callExternalMcpTool(workspaceId, server!, rest.join("__"), payload);
      }
      return { ok: false, summary: `Unknown irreversible tool ${toolName}` };
    }
  }
}
