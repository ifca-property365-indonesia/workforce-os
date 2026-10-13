import { eq } from "drizzle-orm";
import { audit, db, servers } from "@wfos/db";
import { serverVerifySchema } from "@wfos/shared";
import { scanHostKey } from "@wfos/shared/ssh";
import { HttpError } from "@/lib/server/auth";
import { serverEnv } from "@/lib/server/env";
import { publish } from "@/lib/server/queue";
import { rateLimit } from "@/lib/server/ratelimit";
import { body, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";
import { loadServer, probeAndRecord, serverDTO, sshHttpError } from "@/lib/server/servers";

/**
 * The Owner confirms the fingerprint they compared on the server (fresh password + 2FA). The host key is scanned
 * again and must still match; it is then pinned, and the server is probed: ready, or error with a code.
 */
export const POST = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const s = await loadServer(session.workspaceId, params.id);
  await requireStepUp(session);
  const { fingerprint } = await body(req, serverVerifySchema);
  await rateLimit(`servers-ssh:${session.workspaceId}`, 30, 300);
  let scanned;
  try {
    scanned = await scanHostKey({ host: s.host, port: s.port, allowPrivate: serverEnv.appServersAllowPrivate });
  } catch (e) {
    throw sshHttpError(e);
  }
  if (scanned.fingerprint !== fingerprint) {
    throw new HttpError(409, "The server's host key is not the one you confirmed", { code: "host_key_changed", fingerprint: scanned.fingerprint });
  }
  const [pinned] = await db
    .update(servers)
    .set({ hostKeyAlgo: scanned.algo, hostKey: scanned.key, hostKeyFingerprint: scanned.fingerprint, updatedAt: new Date() })
    .where(eq(servers.id, s.id))
    .returning();
  const row = await probeAndRecord(pinned!);
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: row.status === "ready" ? "server.verified" : "server.verify_failed",
    targetType: "server",
    targetId: s.id,
    details: { name: s.name, fingerprint: scanned.fingerprint, algo: scanned.algo, status: row.status, code: row.statusMessage, helperVersion: row.info?.helperVersion ?? null },
  });
  await publish(session.workspaceId, { type: "server.updated", serverId: s.id, status: row.status });
  return { server: serverDTO(row) };
});
