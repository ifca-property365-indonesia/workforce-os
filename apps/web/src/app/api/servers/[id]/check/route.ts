import { audit } from "@wfos/db";
import { publish } from "@/lib/server/queue";
import { rateLimit } from "@/lib/server/ratelimit";
import { route } from "@/lib/server/route";
import { loadServer, probeAndRecord, serverDTO } from "@/lib/server/servers";

/** Probe a verified server again with its pinned host key: ready, or error with a code. */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const s = await loadServer(session.workspaceId, params.id);
  await rateLimit(`servers-ssh:${session.workspaceId}`, 30, 300);
  const row = await probeAndRecord(s);
  if (row.status !== s.status || row.statusMessage !== s.statusMessage) {
    await audit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      actorLabel: session.email,
      action: "server.checked",
      targetType: "server",
      targetId: s.id,
      details: { name: s.name, from: s.status, status: row.status, code: row.statusMessage },
    });
  }
  await publish(session.workspaceId, { type: "server.updated", serverId: s.id, status: row.status });
  return { server: serverDTO(row) };
});
