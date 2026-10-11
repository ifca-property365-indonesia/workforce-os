import { SsrfBlockedError } from "@wfos/shared/netguard";
import { HttpError } from "@/lib/server/auth";
import { logger } from "@/lib/server/logger";
import { getMcpServer, listMcpTools, mcpErrorKind, mcpUrl } from "@/lib/server/mcp";
import { notFound, route } from "@/lib/server/route";

/** Connect to a configured MCP server and list its tools, each classified like the worker's gate would. */
export const GET = route<{ name: string }>("ADMIN", async ({ session, params }) => {
  const server = await getMcpServer(session.workspaceId, params.name);
  if (!server) notFound("mcp_server_not_found");
  mcpUrl(server.url);
  try {
    const tools = await listMcpTools(server);
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools };
  } catch (e) {
    // a destination other than the configured host (e.g. its DNS now answers a private address): refused, not "down"
    if (e instanceof SsrfBlockedError || (e as { cause?: unknown })?.cause instanceof SsrfBlockedError) {
      logger.warn({ server: server.name }, "mcp tools listing refused by the SSRF guard");
      throw new HttpError(400, "MCP server address is not public", { code: "mcp_url_not_public", name: server.name });
    }
    // The upstream text stays in the server log: it can carry anything the remote server chose to answer.
    const kind = mcpErrorKind(e);
    logger.warn({ server: server.name, ...kind, err: ((e as Error)?.message || String(e)).slice(0, 500) }, "mcp tools listing failed");
    throw new HttpError(502, "MCP server unreachable", { code: "mcp_unreachable", name: server.name, ...kind });
  }
});
