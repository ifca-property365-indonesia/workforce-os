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
    // The upstream text stays in the server log: it can carry anything the remote server chose to answer.
    const kind = mcpErrorKind(e);
    logger.warn({ server: server.name, ...kind, err: ((e as Error)?.message || String(e)).slice(0, 500) }, "mcp tools listing failed");
    throw new HttpError(502, "MCP server unreachable", { code: "mcp_unreachable", name: server.name, ...kind });
  }
});
