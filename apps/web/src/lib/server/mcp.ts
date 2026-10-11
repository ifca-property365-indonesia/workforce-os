import "server-only";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { credentials, db } from "@wfos/db";
import { classifyTool, normalizeMcpName, type McpCredentialConfig, type ToolClass } from "@wfos/shared";
import { decryptSecret } from "@wfos/shared/server";
import { assertPublicUrl } from "@wfos/shared/netguard";
import { HttpError } from "./auth";
import { mcpOAuthAccessToken } from "./mcp-oauth-refresh";

/**
 * Same rule as the shared permission schema's `mcp:<server>`: [a-z0-9-] parts joined by single "_", 2–32 chars.
 * "__" is refused because the Claude SDK names MCP tools `mcp__<server>__<tool>`, so it would split the name.
 */
export const MCP_SERVER_NAME_RE = /^(?=.{2,32}$)[a-z0-9-]+(?:_[a-z0-9-]+)*$/;

/** Names that would shadow the Settings API's own paths (/api/settings/mcp/oauth/…, …/<name>/tools). */
export const MCP_RESERVED_NAMES: readonly string[] = ["oauth", "tools"];

/** A server name an Owner may save: the shared rule, and not a reserved word (400 otherwise). */
export function assertMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_RE.test(name)) throw new HttpError(400, "Invalid MCP server name", { code: "mcp_invalid_name" });
  if (MCP_RESERVED_NAMES.includes(name)) throw new HttpError(400, "This MCP server name is reserved", { code: "mcp_reserved_name", name });
}

export interface McpServerConfig {
  name: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Hosts the listing may reach although they are not public: only the host an Owner saved for this server
   * (Settings → Integrations). Every other host must resolve to public addresses only.
   */
  allowHosts: string[];
}

export interface McpToolInfo {
  /** the server's own tool name, for display */
  name: string;
  /** the name as the gate compares it (normalizeMcpName): what `mcp:<server>:<key>` permission rules use */
  key: string;
  description: string;
  class: ToolClass;
}

export class McpTimeoutError extends Error {
  override name = "McpTimeoutError";
}

/**
 * What of a failed listing may be shown to the person: the error's class and its code (ECONNREFUSED, an HTTP
 * status, a JSON-RPC code), never its text, which can carry whatever the upstream server answered.
 */
export function mcpErrorKind(e: unknown): { errorClass: string; errorCode?: string } {
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const errorClass = typeof err?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
  const raw = err?.code ?? err?.cause?.code;
  const errorCode = (typeof raw === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(raw)) || typeof raw === "number" ? String(raw) : undefined;
  return errorCode ? { errorClass, errorCode } : { errorClass };
}

/** How long listing a server's tools may take, connect included. */
export const MCP_LIST_TIMEOUT_MS = 10_000;
/** listTools pages followed before giving up (a server with more tools than this is unusual). */
const MAX_PAGES = 10;

/**
 * The workspace's MCP server `name` with its auth header, built like the worker does
 * (apps/worker/src/lib/settings.ts getExternalMcpServers): `authHeader: <secret>` or `Authorization: Bearer <secret>`,
 * and for an OAuth server `Authorization: Bearer <access token>`, refreshed first when it is about to expire (under
 * the worker's lock, see mcp-oauth-refresh.ts). 409 `mcp_server_disabled` for a slot an import left unconfigured
 * (never contacted: its URL came from a package, not an Owner), `mcp_needs_reconnect` when the sign-in must be
 * redone, `mcp_oauth_refreshing` when another refresh is still running or the authorization server is down.
 */
export async function getMcpServer(workspaceId: string, name: string): Promise<McpServerConfig | null> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "mcp"), eq(credentials.name, name)));
  if (!row) return null;
  const cfg = row.config as McpCredentialConfig;
  if (cfg.disabled === true) throw new HttpError(409, "MCP server is not set up yet", { code: "mcp_server_disabled", name: row.name });
  const headers: Record<string, string> = {};
  if (cfg.auth === "oauth") {
    const r = await mcpOAuthAccessToken(row);
    if ("reconnect" in r) throw new HttpError(409, "MCP server needs to be reconnected", { code: "mcp_needs_reconnect", name: row.name });
    if ("retry" in r) throw new HttpError(409, "MCP server token is being refreshed, try again", { code: "mcp_oauth_refreshing", name: row.name });
    headers.Authorization = `Bearer ${r.token}`;
  } else {
    const secret = row.secretEnc ? decryptSecret(row.secretEnc) : "";
    if (secret) headers[cfg.authHeader ?? "Authorization"] = cfg.authHeader ? secret : `Bearer ${secret}`;
  }
  return { name: row.name, url: cfg.url, headers, allowHosts: [hostOf(cfg.url)] };
}

/** The bare host of a URL ("" when it does not parse), as assertPublicUrl compares allowHosts. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Owner-configured URLs are trusted config, but only http(s) is ever fetched. */
export function mcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Invalid MCP server URL", { code: "mcp_invalid_url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "Invalid MCP server URL", { code: "mcp_invalid_url" });
  return url;
}

/**
 * fetch for the MCP transport that never lets the runtime follow a redirect by itself. The SDK
 * (redirectPolicy "same-origin") follows a redirect only within the server's origin and fails on any other, so the
 * configured auth header can never be sent to a host it was not configured for.
 */
export const noAutoRedirectFetch: FetchLike = (url, init) => fetch(url, { ...init, redirect: "manual" });

/**
 * noAutoRedirectFetch behind the SSRF guard: every request (the first, and each same-origin redirect the SDK
 * follows) must go to a public address, or to one of `allowHosts` (the host an Owner saved).
 */
export function guardedMcpFetch(allowHosts: string[], base: FetchLike = noAutoRedirectFetch): FetchLike {
  return async (url, init) => {
    await assertPublicUrl(String(url), { allowHosts });
    return base(url, init);
  };
}

/** Connect, list every tool (following pagination), classify each one, close. Rejects after `timeoutMs`. */
export async function listMcpTools(server: McpServerConfig, timeoutMs = MCP_LIST_TIMEOUT_MS): Promise<McpToolInfo[]> {
  const url = mcpUrl(server.url);
  const client = new Client({ name: "workforce-os", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: server.headers },
    redirectPolicy: "same-origin",
    fetch: guardedMcpFetch(server.allowHosts),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  const work = async () => {
    await client.connect(transport, { timeout: timeoutMs });
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
      for (const tool of r.tools) out.push({ name: tool.name, key: normalizeMcpName(tool.name), description: tool.description ?? "", class: classifyTool(tool.name) });
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  };
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
