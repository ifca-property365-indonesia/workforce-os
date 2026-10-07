import { credentials, db, workspaces } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import type { SmtpConfig } from "@wfos/shared/mail";
import { and, eq } from "drizzle-orm";

export async function getWorkspace(workspaceId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);
  return ws;
}

export async function getSmtp(workspaceId: string): Promise<SmtpConfig | null> {
  const [c] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "smtp"), eq(credentials.name, "default")));
  if (!c) return null;
  const cfg = c.config as { host: string; port: number; secure: boolean; user: string; fromAddress: string };
  return { ...cfg, password: c.secretEnc ? decryptSecret(c.secretEnc) : "" };
}

export async function getWebhookUrl(workspaceId: string): Promise<string | null> {
  const ws = await getWorkspace(workspaceId);
  return ws.webhookUrlEnc ? decryptSecret(ws.webhookUrlEnc) : null;
}

export interface ExternalMcp {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export async function getExternalMcpServers(workspaceId: string): Promise<ExternalMcp[]> {
  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "mcp")));
  return rows.map((r) => {
    const cfg = r.config as { url: string; authHeader?: string };
    const secret = r.secretEnc ? decryptSecret(r.secretEnc) : "";
    const headers: Record<string, string> = {};
    if (secret) headers[cfg.authHeader ?? "Authorization"] = cfg.authHeader ? secret : `Bearer ${secret}`;
    return { name: r.name, url: cfg.url, headers };
  });
}
