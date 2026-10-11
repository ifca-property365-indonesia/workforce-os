import { NextResponse, type NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpError } from "@/lib/server/auth";
import { authenticateApiToken, MCP_IP_RATE_PER_MIN } from "@/lib/server/api-token";
import { buildMcpServer } from "@/lib/server/mcp-server";
import { logger } from "@/lib/server/logger";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

/** JSON-RPC error envelope (no request id: the request was refused before it was read). */
function rpcError(status: number, message: string, code: string | undefined, headers: Record<string, string> = {}) {
  return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message, data: { code } } }, { status, headers });
}

/**
 * The workforce-os MCP server (Streamable HTTP, stateless, JSON responses): every POST is authenticated with a
 * personal API token and served by a fresh server + transport bound to that token's user and workspace.
 */
export async function POST(req: NextRequest) {
  let session;
  try {
    // per IP before the token is looked up: guessing tokens costs a database query each, so it is bounded first
    await rateLimit(`mcp:ip:${clientIp(req)}`, MCP_IP_RATE_PER_MIN, 60);
    session = await authenticateApiToken(req);
  } catch (e) {
    if (e instanceof HttpError) {
      const headers: Record<string, string> = e.status === 401 ? { "WWW-Authenticate": 'Bearer realm="workforce-os", error="invalid_token"' } : {};
      if (e.status === 429) headers["Retry-After"] = "60";
      return rpcError(e.status, e.message, e.extra.code, headers);
    }
    logger.error({ err: e instanceof Error ? e.name : typeof e }, "mcp auth error");
    return rpcError(500, "Internal error", "internal");
  }
  const server = buildMcpServer(session);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
  // client went away (e.g. during wait_for_task): closing aborts the running tool handlers
  const onAbort = () => void server.close().catch(() => {});
  req.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (e) {
    logger.error({ err: (e as Error).message, stack: (e as Error).stack, tokenId: session.viaToken.id }, "mcp request error");
    return rpcError(500, "Internal error", "internal");
  } finally {
    // JSON mode: the response is complete once handleRequest resolves
    req.signal?.removeEventListener("abort", onAbort);
    await server.close().catch(() => {});
  }
}

/** No server-initiated SSE stream and no sessions in stateless mode. */
function notAllowed() {
  return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } }, { status: 405, headers: { Allow: "POST" } });
}

export const GET = notAllowed;
export const DELETE = notAllowed;
