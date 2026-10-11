import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentials, db, workspaces } from "@wfos/db";
import {
  MCP_OAUTH_FETCH_TIMEOUT_MS,
  MCP_OAUTH_REFRESH_LOCK_MS,
  mcpOAuthExpired,
  mcpOAuthExpiresSoon,
  mcpOAuthExpiry,
  mcpOAuthFetch,
  mcpOAuthRefreshLockKey,
  parseMcpOAuthSecret,
  type McpCredentialConfig,
  type McpOAuthSecret,
} from "@wfos/shared";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { assertPublicUrl } from "@wfos/shared/netguard";
import type { SmtpConfig } from "@wfos/shared/mail";
import { and, eq, sql } from "drizzle-orm";
import { env } from "./env";
import { log } from "./logger";
import { redis } from "./redis";

export async function getWorkspace(workspaceId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);
  return ws;
}

/** Workspace language for notifications and default emails (null = not set → English). */
export async function workspaceLocale(workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ l: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.l ?? null;
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

type CredentialRow = typeof credentials.$inferSelect;

/**
 * The workspace's external MCP servers with their auth headers. Left out (the run goes on without them): servers an
 * import left disabled or without their token, and OAuth servers whose sign-in has to be redone. An OAuth access
 * token close to expiry is refreshed first (once across workers, under a Redis lock).
 */
export async function getExternalMcpServers(workspaceId: string): Promise<ExternalMcp[]> {
  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "mcp")));
  const out: ExternalMcp[] = [];
  for (const r of rows) {
    try {
      const server = await externalMcpServer(r);
      if (server) out.push(server);
    } catch (e) {
      log.warn({ workspaceId, server: r.name, err: (e as Error).message?.slice(0, 300) }, "external mcp server skipped");
    }
  }
  return out;
}

async function externalMcpServer(r: CredentialRow): Promise<ExternalMcp | null> {
  const cfg = r.config as McpCredentialConfig;
  if (cfg.disabled === true) return null;
  if (cfg.auth === "oauth") {
    const token = await oauthAccessToken(r);
    return token ? { name: r.name, url: cfg.url, headers: { Authorization: `Bearer ${token}` } } : null;
  }
  const secret = r.secretEnc ? decryptSecret(r.secretEnc) : "";
  // no token at all is a server that needs none; a token that is stored but empty is an unfinished import
  if (r.secretEnc && !secret.trim()) return null;
  const headers: Record<string, string> = {};
  if (secret) headers[cfg.authHeader ?? "Authorization"] = cfg.authHeader ? secret : `Bearer ${secret}`;
  return { name: r.name, url: cfg.url, headers };
}

/** How long a run waits for another worker's refresh of the same server before going on without it. */
const REFRESH_WAIT_MS = 10_000;
const REFRESH_POLL_MS = 200;
/**
 * The refresh lock outlives a token request that runs into its timeout several times over, so it cannot expire
 * (and be taken by another worker) while its holder is still waiting for the token endpoint.
 */
export const REFRESH_LOCK_MS = Math.max(MCP_OAUTH_REFRESH_LOCK_MS, 3 * MCP_OAUTH_FETCH_TIMEOUT_MS);
/** Delete the lock only while it is still ours (it may have expired and been taken by someone else). */
const RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
/** Token-endpoint errors that are an answer, not an outage: the refresh token or client is no good any more. */
const TRANSIENT_OAUTH_ERRORS = new Set(["server_error", "temporarily_unavailable"]);

interface OAuthState {
  cfg: McpCredentialConfig;
  tokens: McpOAuthSecret;
  /** the stored ciphertext the tokens came from: every write after a refresh is compare-and-set on it */
  secretEnc: string;
}

function oauthState(r: CredentialRow): OAuthState | null {
  const cfg = r.config as McpCredentialConfig;
  if (cfg.auth !== "oauth" || cfg.disabled === true || cfg.needsReauth || !r.secretEnc) return null;
  const tokens = parseMcpOAuthSecret(decryptSecret(r.secretEnc));
  return tokens ? { cfg, tokens, secretEnc: r.secretEnc } : null;
}

async function readOAuthState(id: string): Promise<OAuthState | null> {
  const [r] = await db.select().from(credentials).where(eq(credentials.id, id));
  return r ? oauthState(r) : null;
}

/** What is stored now (someone else refreshed or reconnected meanwhile): its token while it is still valid. */
async function storedToken(id: string): Promise<string | null> {
  const now = await readOAuthState(id);
  return now && !mcpOAuthExpired(now.cfg) ? now.tokens.access_token : null;
}

/** A usable access token for an OAuth server, refreshed when it expires within 5 minutes; null = skip the server. */
async function oauthAccessToken(r: CredentialRow): Promise<string | null> {
  const cur = oauthState(r);
  if (!cur) return null;
  if (!mcpOAuthExpiresSoon(cur.cfg)) return cur.tokens.access_token;
  const key = mcpOAuthRefreshLockKey(env.namespace, r.id);
  const lockId = randomUUID();
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    if ((await redis.set(key, lockId, "PX", REFRESH_LOCK_MS, "NX")) === "OK") {
      try {
        return await refreshOAuthToken(r.id, r.name, async () => (await redis.get(key)) === lockId);
      } finally {
        await redis.eval(RELEASE_LOCK, 1, key, lockId).catch(() => {});
      }
    }
    // another worker is refreshing this server: wait for it, then use what it saved
    await sleep(REFRESH_POLL_MS);
    const now = await readOAuthState(r.id);
    if (!now) return null;
    if (!mcpOAuthExpiresSoon(now.cfg)) return now.tokens.access_token;
    if (Date.now() >= deadline) return mcpOAuthExpired(now.cfg) ? null : now.tokens.access_token;
  }
}

/**
 * Refresh under the lock. Re-reads the row first: the previous lock holder may have refreshed it already. Every
 * write is compare-and-set on the secret it read, so an owner's reconnect meanwhile is never overwritten; a
 * reconnect needed is only recorded while the lock is still ours (`stillLocked`).
 */
async function refreshOAuthToken(id: string, name: string, stillLocked: () => Promise<boolean>): Promise<string | null> {
  const cur = await readOAuthState(id);
  if (!cur) return null;
  if (!mcpOAuthExpiresSoon(cur.cfg)) return cur.tokens.access_token;
  const { cfg, tokens } = cur;
  const needsReauth = async (why: string): Promise<string | null> => {
    if (!(await stillLocked())) {
      // the lock expired meanwhile: another worker may have refreshed (or the owner reconnected) since
      log.warn({ credentialId: id, server: name }, "mcp oauth refresh lock lost: not marking for reconnect");
      return storedToken(id);
    }
    if (!(await markNeedsReauth(id, cur.secretEnc))) return storedToken(id); // reconnected meanwhile
    log.warn({ credentialId: id, server: name }, why);
    return null;
  };
  if (!tokens.refresh_token || !cfg.clientId) {
    if (!mcpOAuthExpired(cfg)) return tokens.access_token;
    return needsReauth("mcp oauth token expired and cannot be refreshed: reconnect needed");
  }
  // the token endpoint must be public, except on the MCP server's own host (which the Owner configured on purpose)
  const mcpHost = new URL(cfg.url).hostname.replace(/^\[|\]$/g, "");
  try {
    const t = await refreshAuthorization(cfg.authServerUrl ?? new URL("/", cfg.url).href, {
      metadata: tokenEndpointMetadata(cfg),
      clientInformation: {
        client_id: cfg.clientId,
        ...(tokens.client_secret ? { client_secret: tokens.client_secret } : {}),
        ...(cfg.tokenEndpointAuthMethod ? { token_endpoint_auth_method: cfg.tokenEndpointAuthMethod } : {}),
      } as OAuthClientInformationMixed,
      refreshToken: tokens.refresh_token,
      resource: cfg.resource,
      fetchFn: mcpOAuthFetch(undefined, MCP_OAUTH_FETCH_TIMEOUT_MS, (u) => assertPublicUrl(u, { allowHosts: [mcpHost] })),
    });
    const next: McpOAuthSecret = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? tokens.refresh_token,
      ...(tokens.client_secret ? { client_secret: tokens.client_secret } : {}),
    };
    const patch = { expiresAt: mcpOAuthExpiry(t.expires_in), ...(t.scope ? { scope: t.scope } : {}) };
    const saved = await db
      .update(credentials)
      .set({ secretEnc: encryptSecret(JSON.stringify(next)), config: sql`(${credentials.config} - 'needsReauth') || ${JSON.stringify(patch)}::jsonb` })
      .where(and(eq(credentials.id, id), eq(credentials.secretEnc, cur.secretEnc)))
      .returning({ id: credentials.id });
    if (!saved.length) {
      // the owner reconnected (or the row changed) while we refreshed: what is stored wins
      log.warn({ credentialId: id, server: name }, "mcp oauth credential changed during refresh: using the stored token");
      return storedToken(id);
    }
    log.info({ credentialId: id, server: name }, "mcp oauth token refreshed");
    return t.access_token;
  } catch (e) {
    const errorCode = (e as { errorCode?: unknown }).errorCode;
    const refused = typeof errorCode === "string" && !TRANSIENT_OAUTH_ERRORS.has(errorCode);
    // the error text can carry what the token endpoint answered: it stays here, trimmed
    log.warn({ credentialId: id, server: name, errorCode, err: (e as Error).message?.slice(0, 300) }, "mcp oauth refresh failed");
    if (refused) return needsReauth("mcp oauth refresh refused: reconnect needed");
    // an outage: the current token while it lasts, nothing after
    return mcpOAuthExpired(cfg) ? null : tokens.access_token;
  }
}

/** Just enough authorization-server metadata for a token request: its endpoint and the auth method chosen at sign-in. */
function tokenEndpointMetadata(cfg: McpCredentialConfig): AuthorizationServerMetadata | undefined {
  if (!cfg.tokenEndpoint) return undefined;
  return {
    issuer: cfg.authServerUrl ?? new URL("/", cfg.tokenEndpoint).href,
    authorization_endpoint: cfg.tokenEndpoint,
    token_endpoint: cfg.tokenEndpoint,
    response_types_supported: ["code"],
    ...(cfg.tokenEndpointAuthMethod ? { token_endpoint_auth_methods_supported: [cfg.tokenEndpointAuthMethod] } : {}),
  };
}

/** Mark the server for a reconnect unless its secret changed since it was read (a reconnect). True when marked. */
async function markNeedsReauth(id: string, secretEnc: string): Promise<boolean> {
  const rows = await db
    .update(credentials)
    .set({ config: sql`${credentials.config} || '{"needsReauth":true}'::jsonb` })
    .where(and(eq(credentials.id, id), eq(credentials.secretEnc, secretEnc)))
    .returning({ id: credentials.id });
  return rows.length > 0;
}
