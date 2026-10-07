import { clients, db, workspaces } from "@wfos/db";
import {
  emailPayloadSchema,
  invoicePayloadSchema,
  invoiceTotal,
  webhookPayloadSchema,
  type EmailPayload,
  type InvoicePayload,
} from "@wfos/shared";
import { withRetry } from "@wfos/shared/server";
import { sendMail } from "@wfos/shared/mail";
import { renderInvoicePdf, formatMoney } from "@wfos/shared/invoice";
import { eq } from "drizzle-orm";
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
  });
  return { pdf: Buffer.from(pdf), client };
}

async function doSendInvoice(workspaceId: string, p: InvoicePayload): Promise<ActionResult> {
  const smtp = await getSmtp(workspaceId);
  if (!smtp) return { ok: false, summary: "SMTP is not configured for this workspace (Settings → Email)." };
  const { pdf, client } = await invoiceAttachment(workspaceId, p, false);
  const to = p.to.length ? p.to : client?.email ? [client.email] : [];
  if (!to.length) return { ok: false, summary: "No recipient for invoice" };
  const total = formatMoney(invoiceTotal(p), p.currency);
  const subject = p.subject || `Invoice ${p.invoiceNumber}`;
  const body = p.body || `Dear ${client?.name ?? "client"},\n\nPlease find attached invoice ${p.invoiceNumber} for ${total}, due ${p.dueDate}.\n\nThank you.`;
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
export async function executeAction(workspaceId: string, toolName: string, payload: Record<string, unknown>): Promise<ActionResult> {
  switch (toolName) {
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
