import { z } from "zod";
import { assertMcpServerName, mcpUrl } from "@/lib/server/mcp";
import { startMcpOAuth } from "@/lib/server/mcp-oauth";
import { body, route } from "@/lib/server/route";

const schema = z.object({ name: z.string(), url: z.string() });

/**
 * Start signing in to an OAuth MCP server. The Settings page shows the authorization server's host and the scopes
 * (warning when that host is on another site than the MCP server) and, once the Owner confirms, sends the browser
 * to `authorizeUrl`; it comes back to ../callback.
 */
export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, schema);
  assertMcpServerName(input.name);
  mcpUrl(input.url);
  return startMcpOAuth({ workspaceId: session.workspaceId, userId: session.userId, name: input.name, url: input.url });
});
