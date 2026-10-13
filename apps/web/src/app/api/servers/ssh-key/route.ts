import { route } from "@/lib/server/route";
import { loadServer, prepareCommand, workspaceKey } from "@/lib/server/servers";

/**
 * The workspace's public SSH key (created on first use) and the prepare command for a server
 * (?serverId= fills in its domain and user). The private key never leaves the server side.
 */
export const GET = route("ADMIN", async ({ session, req }) => {
  const serverId = req.nextUrl.searchParams.get("serverId");
  const server = serverId ? await loadServer(session.workspaceId, serverId) : null;
  const key = await workspaceKey(session.workspaceId);
  return { publicKey: key.publicKey, fingerprint: key.fingerprint, prepareCommand: prepareCommand(key.publicKey, server) };
});
