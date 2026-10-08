import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { getDb } from "./index";
import { credentials } from "./schema";

export type ClaudeCredentialType = "oauth" | "api_key";

export interface ClaudeCredential {
  type: ClaudeCredentialType;
  secret: string;
  source: "workspace" | "instance";
}

/** What the browser may see about a credential: never the secret. */
export interface ClaudeCredentialStatus {
  workspace: { type: ClaudeCredentialType; last4: string; updatedAt: string } | null;
  instance: { enabled: boolean; type: ClaudeCredentialType; present: boolean };
  /** the credential a run would use right now */
  effective: { source: "workspace" | "instance"; type: ClaudeCredentialType } | null;
}

const KIND = "claude";
const NAME = "default";

/** The instance-level env credential, usable only while CLAUDE_INSTANCE_FALLBACK is not "false". */
export function instanceClaudeCredential(env: NodeJS.ProcessEnv = process.env): (ClaudeCredential & { enabled: boolean }) | null {
  const type: ClaudeCredentialType = env.CLAUDE_AUTH_MODE === "api_key" ? "api_key" : "oauth";
  const secret = (type === "api_key" ? env.ANTHROPIC_API_KEY : env.CLAUDE_CODE_OAUTH_TOKEN) ?? "";
  const enabled = env.CLAUDE_INSTANCE_FALLBACK !== "false";
  return { type, secret, source: "instance", enabled };
}

async function workspaceRow(workspaceId: string) {
  const [row] = await getDb()
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, KIND), eq(credentials.name, NAME)));
  return row;
}

/**
 * The credential for one run: the workspace's own, else the instance fallback (if enabled and set), else null.
 * Only this workspace's credential is ever returned, so a run can never use another tenant's.
 */
export async function resolveClaudeCredential(workspaceId: string): Promise<ClaudeCredential | null> {
  const row = await workspaceRow(workspaceId);
  if (row?.secretEnc) {
    const cfg = row.config as { type: ClaudeCredentialType };
    return { type: cfg.type, secret: decryptSecret(row.secretEnc), source: "workspace" };
  }
  const inst = instanceClaudeCredential();
  if (inst && inst.enabled && inst.secret) return { type: inst.type, secret: inst.secret, source: "instance" };
  return null;
}

export async function claudeCredentialStatus(workspaceId: string): Promise<ClaudeCredentialStatus> {
  const row = await workspaceRow(workspaceId);
  const inst = instanceClaudeCredential()!;
  const cfg = row?.config as { type: ClaudeCredentialType; last4: string } | undefined;
  const ws = row?.secretEnc && cfg ? { type: cfg.type, last4: cfg.last4, updatedAt: row.updatedAt.toISOString() } : null;
  return {
    workspace: ws,
    instance: { enabled: inst.enabled, type: inst.type, present: !!inst.secret },
    effective: ws ? { source: "workspace", type: ws.type } : inst.enabled && inst.secret ? { source: "instance", type: inst.type } : null,
  };
}

export async function setClaudeCredential(workspaceId: string, type: ClaudeCredentialType, secret: string): Promise<void> {
  const config = { type, last4: secret.slice(-4) };
  await getDb()
    .insert(credentials)
    .values({ workspaceId, kind: KIND, name: NAME, config, secretEnc: encryptSecret(secret) })
    .onConflictDoUpdate({ target: [credentials.workspaceId, credentials.kind, credentials.name], set: { config, secretEnc: encryptSecret(secret), updatedAt: new Date() } });
}

export async function removeClaudeCredential(workspaceId: string): Promise<void> {
  await getDb()
    .delete(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, KIND), eq(credentials.name, NAME)));
}
