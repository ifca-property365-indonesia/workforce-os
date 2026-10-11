import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentials, db } from "@wfos/db";
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
import { serverEnv } from "./env";
import { logger } from "./logger";
import { redis } from "./queue";

/**
 * The web's side of OAuth token refresh for external MCP servers (listing a server's tools in Settings). It behaves
 * exactly like the worker's (apps/worker/src/lib/settings.ts oauthAccessToken / refreshOAuthToken): the same Redis
 * lock key (mcpOAuthRefreshLockKey) so a web request and a run refresh once between them, the same re-read under
 * the lock, compare-and-set on the stored ciphertext for every write, and a reconnect recorded only while the lock
 * is still held. The only difference is the answer: the worker skips a server it cannot use, the web says why.
 */

type CredentialRow = typeof credentials.$inferSelect;

/** token: use it. reconnect: the owner must sign in again. retry: someone else is refreshing, or the AS is down. */
export type McpOAuthTokenResult = { token: string } | { reconnect: true } | { retry: true };

/** How long a request waits for another refresh of the same server (the worker's REFRESH_WAIT_MS). */
const REFRESH_WAIT_MS = 10_000;
const REFRESH_POLL_MS = 200;
/** The worker's REFRESH_LOCK_MS: outlives a token request that times out several times over. */
export const REFRESH_LOCK_MS = Math.max(MCP_OAUTH_REFRESH_LOCK_MS, 3 * MCP_OAUTH_FETCH_TIMEOUT_MS);
/** Delete the lock only while it is still ours. */
const RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
/** Token-endpoint errors that are an outage, not an answer. */
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
async function storedToken(id: string): Promise<McpOAuthTokenResult> {
  const now = await readOAuthState(id);
  if (!now) return { reconnect: true };
  return mcpOAuthExpired(now.cfg) ? { retry: true } : { token: now.tokens.access_token };
}

/**
 * The OAuth server's state as Settings shows it: reconnect only when the sign-in has to be redone (refused refresh,
 * no tokens) or the access token expired with nothing to refresh it with. An expired token that can be refreshed is
 * fine: the next use refreshes it.
 */
export function mcpOAuthNeedsReconnect(r: Pick<CredentialRow, "config" | "secretEnc">): boolean {
  const cfg = r.config as McpCredentialConfig;
  if (cfg.auth !== "oauth") return false;
  if (!r.secretEnc || cfg.needsReauth) return true;
  const tokens = parseMcpOAuthSecret(decryptSecret(r.secretEnc));
  if (!tokens) return true;
  return mcpOAuthExpired(cfg) && !(tokens.refresh_token && cfg.clientId);
}

/** A usable access token for an OAuth server, refreshed (under the shared lock) when it expires within 5 minutes. */
export async function mcpOAuthAccessToken(r: CredentialRow): Promise<McpOAuthTokenResult> {
  const cur = oauthState(r);
  if (!cur) return { reconnect: true };
  if (!mcpOAuthExpiresSoon(cur.cfg)) return { token: cur.tokens.access_token };
  const key = mcpOAuthRefreshLockKey(serverEnv.namespace, r.id);
  const lockId = randomUUID();
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    if ((await redis().set(key, lockId, "PX", REFRESH_LOCK_MS, "NX")) === "OK") {
      try {
        return await refreshOAuthToken(r.id, r.name, async () => (await redis().get(key)) === lockId);
      } finally {
        await redis()
          .eval(RELEASE_LOCK, 1, key, lockId)
          .catch(() => {});
      }
    }
    // a run (or another request) is refreshing this server: wait for it, then use what it saved
    await sleep(REFRESH_POLL_MS);
    const now = await readOAuthState(r.id);
    if (!now) return { reconnect: true };
    if (!mcpOAuthExpiresSoon(now.cfg)) return { token: now.tokens.access_token };
    if (Date.now() >= deadline) return mcpOAuthExpired(now.cfg) ? { retry: true } : { token: now.tokens.access_token };
  }
}

async function refreshOAuthToken(id: string, name: string, stillLocked: () => Promise<boolean>): Promise<McpOAuthTokenResult> {
  const cur = await readOAuthState(id);
  if (!cur) return { reconnect: true };
  if (!mcpOAuthExpiresSoon(cur.cfg)) return { token: cur.tokens.access_token };
  const { cfg, tokens } = cur;
  const needsReauth = async (why: string): Promise<McpOAuthTokenResult> => {
    if (!(await stillLocked())) {
      logger.warn({ credentialId: id, server: name }, "mcp oauth refresh lock lost: not marking for reconnect");
      return storedToken(id);
    }
    if (!(await markNeedsReauth(id, cur.secretEnc))) return storedToken(id); // reconnected meanwhile
    logger.warn({ credentialId: id, server: name }, why);
    return { reconnect: true };
  };
  if (!tokens.refresh_token || !cfg.clientId) {
    if (!mcpOAuthExpired(cfg)) return { token: tokens.access_token };
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
      logger.warn({ credentialId: id, server: name }, "mcp oauth credential changed during refresh: using the stored token");
      return storedToken(id);
    }
    logger.info({ credentialId: id, server: name }, "mcp oauth token refreshed");
    return { token: t.access_token };
  } catch (e) {
    const raw = (e as { errorCode?: unknown }).errorCode;
    const errorCode = typeof raw === "string" ? raw.slice(0, 64) : undefined;
    const refused = !!errorCode && !TRANSIENT_OAUTH_ERRORS.has(errorCode);
    // the OAuth error code and the error class only: the text can carry what the token endpoint answered
    logger.warn({ credentialId: id, server: name, errorCode, errorClass: e instanceof Error ? e.name : typeof e }, "mcp oauth refresh failed");
    if (refused) return needsReauth("mcp oauth refresh refused: reconnect needed");
    // an outage: the current token while it lasts
    return mcpOAuthExpired(cfg) ? { retry: true } : { token: tokens.access_token };
  }
}

/** Just enough authorization-server metadata for a token request (as the worker builds it). */
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
