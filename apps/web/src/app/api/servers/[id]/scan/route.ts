import { scanHostKey } from "@wfos/shared/ssh";
import { serverEnv } from "@/lib/server/env";
import { rateLimit } from "@/lib/server/ratelimit";
import { route } from "@/lib/server/route";
import { loadServer, sshHttpError } from "@/lib/server/servers";

/** Read the server's host key so the Owner can compare its fingerprint on the server. Nothing is stored. */
export const POST = route<{ id: string }>("OWNER", async ({ session, params }) => {
  const s = await loadServer(session.workspaceId, params.id);
  await rateLimit(`servers-ssh:${session.workspaceId}`, 30, 300);
  try {
    const k = await scanHostKey({ host: s.host, port: s.port, allowPrivate: serverEnv.appServersAllowPrivate });
    return { algo: k.algo, fingerprint: k.fingerprint };
  } catch (e) {
    throw sshHttpError(e);
  }
});
