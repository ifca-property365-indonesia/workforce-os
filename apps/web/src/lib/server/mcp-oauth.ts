import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { audit, credentials, db } from "@wfos/db";
import {
  MCP_OAUTH_STATE_TTL_SEC,
  McpOAuthFetchError,
  isOAuthMcp,
  mcpOAuthExpiry,
  mcpOAuthFetch,
  mcpOAuthStateKey,
  parseMcpOAuthSecret,
  type McpCredentialConfig,
  type McpOAuthSecret,
} from "@wfos/shared";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { assertPublicUrl, SsrfBlockedError } from "@wfos/shared/netguard";
import { HttpError } from "./auth";
import { serverEnv } from "./env";
import { logger } from "./logger";
import { redis } from "./queue";

export const MCP_OAUTH_CLIENT_NAME = "Workforce OS";

export const mcpOAuthRedirectUrl = () => `${serverEnv.appUrl}/api/settings/mcp/oauth/callback`;

/** A started sign-in, kept (encrypted) in Redis under its state until the callback takes it. */
export interface PendingMcpOAuth {
  workspaceId: string;
  userId: string;
  name: string;
  url: string;
  codeVerifier: string;
  clientInformation: OAuthClientInformationMixed;
  authServerUrl: string;
  authServerMetadata?: AuthorizationServerMetadata;
  resource?: string;
  scope?: string;
  redirectUri: string;
}

/**
 * What a log line may say about a failed OAuth call: the OAuth error code (invalid_client, …) when the server sent
 * one, else the error's class. Never the text: it can carry whatever the remote server answered.
 */
export function oauthErrorTag(e: unknown): { errorCode?: string; errorClass: string } {
  const raw = (e as { errorCode?: unknown } | null)?.errorCode;
  const errorCode = typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
  const name = (e as { name?: unknown } | null)?.name;
  const errorClass = typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
  return errorCode ? { errorCode, errorClass } : { errorClass };
}

/** Host of a URL without IPv6 brackets, lower case. */
const bareHost = (u: string | URL) => new URL(String(u)).hostname.replace(/^\[|\]$/g, "").toLowerCase();

/**
 * Registrable part of a host, approximately (no public-suffix list here): the last two labels, or three under a
 * two-letter country code with a short second level (co.uk, com.au, co.id). An IP address is its own site.
 */
function siteOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  const n = labels.length >= 3 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3 ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** True when the authorization server is on the same site as the MCP server (same registrable domain). */
export function sameSite(a: string, b: string): boolean {
  return siteOf(a) === siteOf(b);
}

/**
 * fetch for every OAuth request about this MCP server: the SDK's rules (http(s) only, no cross-origin redirect) and
 * the SSRF guard. The MCP server's own host is allowed as the Owner typed it; the authorization server, its
 * registration and token endpoints must resolve to public addresses.
 */
export function mcpOAuthFetchFor(mcpServerUrl: string): ReturnType<typeof mcpOAuthFetch> {
  const allowHosts = [bareHost(mcpServerUrl)];
  return mcpOAuthFetch(undefined, undefined, (u) => assertPublicUrl(u, { allowHosts }));
}

/** What the Owner confirms before the browser goes to the authorization server. */
export interface McpOAuthStart {
  authorizeUrl: string;
  /** the host the Owner will sign in at */
  authorizationServerHost: string;
  /** the scopes requested (empty: the server's default) */
  scopes: string[];
  /** false = the authorization server is on another site than the MCP server: worth a second look */
  sameSite: boolean;
}

function discoveryFailed(name: string, e: unknown): never {
  if (e instanceof HttpError) throw e;
  // a destination the SSRF guard refused: the McpOAuthFetchError text says which host, the log gets the class only
  const blocked = e instanceof SsrfBlockedError || e instanceof McpOAuthFetchError;
  logger.warn({ server: name, ...oauthErrorTag(e), blocked }, "mcp oauth discovery failed");
  throw new HttpError(502, "MCP server OAuth discovery failed", { code: "mcp_oauth_discovery_failed", name });
}

/**
 * Begin signing in to an MCP server: discover its authorization server (RFC 9728 protected resource metadata, then
 * RFC 8414 / OIDC metadata), register this app as a client unless the same server already has one, and build the
 * authorization URL (PKCE S256, a random 32-byte state). The verifier and client stay in Redis for 10 minutes.
 */
export async function startMcpOAuth(input: { workspaceId: string; userId: string; name: string; url: string }): Promise<McpOAuthStart> {
  const fetchFn = mcpOAuthFetchFor(input.url);
  const redirectUri = mcpOAuthRedirectUrl();

  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(input.url, { fetchFn });
  } catch (e) {
    discoveryFailed(input.name, e);
  }
  const { authorizationServerUrl: authServerUrl, authorizationServerMetadata: metadata, resourceMetadata } = info;

  // RFC 8707: the resource indicator is the one the server advertises, sent verbatim, and it must cover the URL
  let resource: string | undefined;
  if (resourceMetadata?.resource) {
    if (!checkResourceAllowed({ requestedResource: input.url, configuredResource: resourceMetadata.resource })) {
      logger.warn({ server: input.name }, "mcp oauth: protected resource metadata names another resource");
      throw new HttpError(502, "MCP server OAuth discovery failed", { code: "mcp_oauth_discovery_failed", name: input.name });
    }
    resource = resourceMetadata.resource;
  }
  const scope = resourceMetadata?.scopes_supported?.length ? resourceMetadata.scopes_supported.join(" ") : undefined;

  const clientInformation = (await registeredClient(input, authServerUrl, redirectUri)) ?? (await register(input.name, authServerUrl, metadata, redirectUri, scope, fetchFn));

  const state = randomBytes(32).toString("base64url");
  let authorizationUrl: URL;
  let codeVerifier: string;
  try {
    ({ authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, { metadata, clientInformation, redirectUrl: redirectUri, scope, state, resource }));
  } catch (e) {
    logger.warn({ server: input.name, ...oauthErrorTag(e) }, "mcp oauth: authorization server is not compatible");
    throw new HttpError(502, "MCP server OAuth discovery failed", { code: "mcp_oauth_discovery_failed", name: input.name });
  }
  // the browser is sent to the authorization endpoint: it must be http(s) (https unless it is a local host)
  if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
    logger.warn({ server: input.name }, "mcp oauth: authorization endpoint is not http(s)");
    throw new HttpError(502, "MCP server OAuth discovery failed", { code: "mcp_oauth_discovery_failed", name: input.name });
  }
  const pending: PendingMcpOAuth = { ...input, codeVerifier, clientInformation, authServerUrl, authServerMetadata: metadata, resource, scope, redirectUri };
  await redis().set(mcpOAuthStateKey(serverEnv.namespace, state), encryptSecret(JSON.stringify(pending)), "EX", MCP_OAUTH_STATE_TTL_SEC);
  const authorizationServerHost = authorizationUrl.host.toLowerCase();
  return {
    authorizeUrl: authorizationUrl.href,
    authorizationServerHost,
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
    sameSite: sameSite(bareHost(authorizationUrl), bareHost(input.url)),
  };
}

/** The client this app registered earlier with the same authorization server for this server (a reconnect). */
async function registeredClient(input: { workspaceId: string; name: string; url: string }, authServerUrl: string, redirectUri: string): Promise<OAuthClientInformationMixed | null> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, input.workspaceId), eq(credentials.kind, "mcp"), eq(credentials.name, input.name)));
  if (!row) return null;
  const cfg = row.config as McpCredentialConfig;
  if (!isOAuthMcp(cfg) || !cfg.clientId || cfg.url !== input.url || cfg.authServerUrl !== authServerUrl || cfg.redirectUri !== redirectUri) return null;
  const secret = row.secretEnc ? parseMcpOAuthSecret(decryptSecret(row.secretEnc)) : null;
  return {
    client_id: cfg.clientId,
    ...(secret?.client_secret ? { client_secret: secret.client_secret } : {}),
    ...(cfg.tokenEndpointAuthMethod ? { token_endpoint_auth_method: cfg.tokenEndpointAuthMethod } : {}),
  } as OAuthClientInformationMixed;
}

/** RFC 7591 dynamic client registration. */
async function register(
  name: string,
  authServerUrl: string,
  metadata: AuthorizationServerMetadata | undefined,
  redirectUri: string,
  scope: string | undefined,
  fetchFn: ReturnType<typeof mcpOAuthFetch>,
): Promise<OAuthClientInformationMixed> {
  try {
    return await registerClient(authServerUrl, {
      metadata,
      clientMetadata: { client_name: MCP_OAUTH_CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
      scope,
      fetchFn,
    });
  } catch (e) {
    logger.warn({ server: name, ...oauthErrorTag(e) }, "mcp oauth client registration failed");
    throw new HttpError(502, "MCP server OAuth client registration failed", { code: "mcp_oauth_registration_failed", name });
  }
}

/**
 * Take a started sign-in by its state, once. Unknown, expired and already used states are null, and so is a state
 * started by another person or in another workspace (it is left in place, so a stray request cannot burn it).
 */
export async function takeMcpOAuthState(state: string, who: { userId: string; workspaceId: string }): Promise<PendingMcpOAuth | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  const key = mcpOAuthStateKey(serverEnv.namespace, state);
  const stored = await redis().get(key);
  const pending = parse(stored);
  if (!pending || pending.userId !== who.userId || pending.workspaceId !== who.workspaceId) return null;
  // GETDEL is the single use: of two callbacks racing with the same state only one gets it
  return (await redis().getdel(key)) === stored ? pending : null;
}

function parse(stored: string | null): PendingMcpOAuth | null {
  if (!stored) return null;
  try {
    return JSON.parse(decryptSecret(stored)) as PendingMcpOAuth;
  } catch {
    return null;
  }
}

/**
 * Exchange the authorization code and save the server: config holds only what is not secret (endpoints, client id,
 * expiry), secretEnc the encrypted tokens and client secret.
 */
export async function finishMcpOAuth(pending: PendingMcpOAuth, code: string, actor: { userId: string; email: string }): Promise<void> {
  const metadata = pending.authServerMetadata;
  const tokens = await exchangeAuthorization(pending.authServerUrl, {
    metadata,
    clientInformation: pending.clientInformation,
    authorizationCode: code,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
    resource: pending.resource,
    fetchFn: mcpOAuthFetchFor(pending.url),
  });
  const scope = tokens.scope ?? pending.scope;
  const config: McpCredentialConfig = {
    url: pending.url,
    auth: "oauth",
    authServerUrl: pending.authServerUrl,
    tokenEndpoint: metadata?.token_endpoint ?? new URL("/token", pending.authServerUrl).href,
    // chosen once here, so the worker's refresh authenticates exactly like this exchange did
    tokenEndpointAuthMethod: selectClientAuthMethod(pending.clientInformation, metadata?.token_endpoint_auth_methods_supported ?? []),
    clientId: pending.clientInformation.client_id,
    ...(pending.resource ? { resource: pending.resource } : {}),
    expiresAt: mcpOAuthExpiry(tokens.expires_in),
    ...(scope ? { scope } : {}),
    redirectUri: pending.redirectUri,
  };
  const secret: McpOAuthSecret = {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(pending.clientInformation.client_secret ? { client_secret: pending.clientInformation.client_secret } : {}),
  };
  const secretEnc = encryptSecret(JSON.stringify(secret));
  await db
    .insert(credentials)
    .values({ workspaceId: pending.workspaceId, kind: "mcp", name: pending.name, config, secretEnc })
    .onConflictDoUpdate({ target: [credentials.workspaceId, credentials.kind, credentials.name], set: { config, secretEnc } });
  await audit({
    workspaceId: pending.workspaceId,
    actorUserId: actor.userId,
    actorLabel: actor.email,
    action: "credential.mcp_oauth_connected",
    targetType: "credential",
    targetId: pending.name,
    details: { url: pending.url, authServer: pending.authServerUrl, ...(scope ? { scope } : {}), refreshable: !!tokens.refresh_token },
  });
}
