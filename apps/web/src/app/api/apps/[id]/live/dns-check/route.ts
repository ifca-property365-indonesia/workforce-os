import { eq } from "drizzle-orm";
import { appEnvironments, audit, db, servers } from "@wfos/db";
import { checkDomains } from "@wfos/shared/dns";
import { HttpError } from "@/lib/server/auth";
import { appDTO, loadApp, loadEnv } from "@/lib/server/apps";
import { publish } from "@/lib/server/queue";
import { rateLimit } from "@/lib/server/ratelimit";
import { route } from "@/lib/server/route";

/**
 * Check now whether the live domain and its extra names point at the live server (public DNS, A/AAAA), and store
 * the result: a live deploy waits for "ok". Admins and up.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, a.id, "live");
  await rateLimit(`app-dns:${session.userId}`, 30, 300);
  const [server] = await db.select({ host: servers.host }).from(servers).where(eq(servers.id, env.serverId));
  if (!server) throw new HttpError(409, "The server is not ready", { code: "server_not_ready" });
  const dnsCheck = await checkDomains([env.domain, ...(env.extraDomains ?? [])], server.host);
  await db.update(appEnvironments).set({ dnsCheck, updatedAt: new Date() }).where(eq(appEnvironments.id, env.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.live_dns_checked",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environmentId: env.id, status: dnsCheck.status, names: dnsCheck.names.map((n) => ({ name: n.name, status: n.status })) },
  });
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: env.status, environmentId: env.id });
  return { dnsCheck, app: await appDTO(session.workspaceId, a.id) };
});
