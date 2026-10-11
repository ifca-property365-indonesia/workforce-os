/**
 * OAuth for external MCP servers: what the web (sign-in, token listing) and the worker (refresh, headers) agree on.
 * Pure helpers only: the MCP SDK calls live in apps/web/src/lib/server/mcp-oauth.ts and apps/worker/src/lib/settings.ts.
 */

/** credentials.config of an MCP server (kind "mcp"). Tokens are never here: they live in secretEnc. */
export type McpCredentialConfig = {
  url: string;
  /** header name for a plain token; absent = `Authorization: Bearer <token>` */
  authHeader?: string;
  /** "oauth" = secretEnc holds an McpOAuthSecret JSON; absent = secretEnc is the plain token */
  auth?: "oauth";
  /** set by an import that still needs the owner to finish setup: the worker never connects it */
  disabled?: boolean;
  /** the authorization server (issuer) the tokens came from */
  authServerUrl?: string;
  tokenEndpoint?: string;
  /** client authentication at the token endpoint, chosen once at sign-in (none / client_secret_basic / client_secret_post) */
  tokenEndpointAuthMethod?: string;
  clientId?: string;
  /** the redirect URI the client was registered with: a reconnect reuses the client only while it is unchanged */
  redirectUri?: string;
  /** RFC 8707 resource indicator sent with every token request, verbatim from the server's metadata */
  resource?: string;
  /** access token expiry (epoch ms); null = the server did not say */
  expiresAt?: number | null;
  scope?: string;
  /** the refresh token was refused: the owner must sign in again (Settings → Integrations → Reconnect) */
  needsReauth?: boolean;
};

/** secretEnc of an OAuth MCP server, decrypted. */
export interface McpOAuthSecret {
  access_token: string;
  refresh_token?: string;
  client_secret?: string;
}

/** The worker refreshes an access token this long before it expires. */
export const MCP_OAUTH_REFRESH_SKEW_MS = 5 * 60_000;
/** How long a started sign-in (state, PKCE verifier) waits for its callback. */
export const MCP_OAUTH_STATE_TTL_SEC = 600;
/** Redis lock around one server's refresh, so concurrent runs refresh once. */
export const MCP_OAUTH_REFRESH_LOCK_MS = 45_000;
/** Every discovery / registration / token request gives up after this long. */
export const MCP_OAUTH_FETCH_TIMEOUT_MS = 15_000;

const ns = (namespace: string) => (namespace ? `${namespace}:` : "");
export const mcpOAuthStateKey = (namespace: string, state: string) => `${ns(namespace)}wfos:mcp-oauth:${state}`;
export const mcpOAuthRefreshLockKey = (namespace: string, credentialId: string) => `${ns(namespace)}wfos:mcp-oauth-refresh:${credentialId}`;

export function isOAuthMcp(cfg: Pick<McpCredentialConfig, "auth">): boolean {
  return cfg.auth === "oauth";
}

/** The decrypted secretEnc of an OAuth server, or null when it is not one (empty, not JSON, no access token). */
export function parseMcpOAuthSecret(plain: string): McpOAuthSecret | null {
  if (!plain) return null;
  try {
    const v = JSON.parse(plain) as Partial<McpOAuthSecret> | null;
    if (!v || typeof v.access_token !== "string" || !v.access_token) return null;
    return {
      access_token: v.access_token,
      ...(typeof v.refresh_token === "string" && v.refresh_token ? { refresh_token: v.refresh_token } : {}),
      ...(typeof v.client_secret === "string" && v.client_secret ? { client_secret: v.client_secret } : {}),
    };
  } catch {
    return null;
  }
}

/** The access token has expired (no expiry known = never). */
export function mcpOAuthExpired(cfg: Pick<McpCredentialConfig, "expiresAt">, now = Date.now()): boolean {
  return typeof cfg.expiresAt === "number" && cfg.expiresAt <= now;
}

/** The access token expires within `skewMs` (or already has): time to refresh. */
export function mcpOAuthExpiresSoon(cfg: Pick<McpCredentialConfig, "expiresAt">, now = Date.now(), skewMs = MCP_OAUTH_REFRESH_SKEW_MS): boolean {
  return typeof cfg.expiresAt === "number" && cfg.expiresAt - skewMs <= now;
}

/** Token response `expires_in` (seconds) as an absolute expiry. */
export function mcpOAuthExpiry(expiresIn: number | undefined, now = Date.now()): number | null {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? now + Math.floor(expiresIn * 1000) : null;
}

export class McpOAuthFetchError extends Error {
  override name = "McpOAuthFetchError";
}

type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * fetch for the SDK's OAuth helpers (discovery, registration, token requests). Only http(s) URLs are fetched, the
 * runtime never follows a redirect by itself, and a redirect to another origin or scheme is refused outright. The
 * SDK follows a same-origin redirect itself by calling this again with the new URL, which is checked the same way.
 * Each request is cut off after `timeoutMs` unless the caller passed its own signal.
 */
export function mcpOAuthFetch(
  base?: FetchFn,
  timeoutMs = MCP_OAUTH_FETCH_TIMEOUT_MS,
  /** server-side destination check (netguard assertPublicUrl), run before every request */
  checkUrl?: (url: URL) => Promise<void>,
): FetchFn {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpOAuthFetchError(`refused non-http(s) URL (${url.protocol})`);
    if (checkUrl) {
      try {
        await checkUrl(url);
      } catch (e) {
        throw new McpOAuthFetchError(`refused ${url.host}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const doFetch = base ?? (globalThis.fetch as FetchFn);
    const res = await doFetch(url, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        let target: URL;
        try {
          target = new URL(location, url);
        } catch {
          throw new McpOAuthFetchError("refused a redirect to an invalid URL");
        }
        if ((target.protocol !== "http:" && target.protocol !== "https:") || target.origin !== url.origin) {
          throw new McpOAuthFetchError(`refused a redirect from ${url.origin} to another origin`);
        }
      }
    }
    return res;
  };
}
