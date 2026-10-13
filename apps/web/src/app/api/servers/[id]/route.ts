import { count, eq } from "drizzle-orm";
import { apps, audit, db, servers } from "@wfos/db";
import { serverInputSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { publish } from "@/lib/server/queue";
import { patchBody, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";
import { assertHostAllowed, assertUnique, duplicateError, loadServer, serverDTO } from "@/lib/server/servers";

const patchSchema = serverInputSchema.pick({ name: true, host: true, port: true, username: true, baseDomain: true, maxRunningApps: true }).partial();
/** changing where or as whom we connect, or the domain, makes the old verification meaningless */
const CONNECTION_FIELDS = ["host", "port", "username", "baseDomain"] as const;

/** Rename, change the app limit, or move the server; moving it resets the pinned host key and status to pending. */
export const PATCH = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const s = await loadServer(session.workspaceId, params.id);
  const input = await patchBody(req, patchSchema);
  if (input.host !== undefined) assertHostAllowed(input.host);
  await assertUnique(session.workspaceId, { name: input.name, baseDomain: input.baseDomain }, s.id);
  const moved = CONNECTION_FIELDS.some((k) => input[k] !== undefined && input[k] !== s[k]);
  if (moved) {
    // the apps' units, files and databases live on that machine at <slug>.<baseDomain>: never repoint them silently
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(apps).where(eq(apps.serverId, s.id));
    if (n > 0) throw new HttpError(409, "Remove this server's apps before changing its address or domain", { code: "server_has_apps", count: n });
  }
  let row;
  try {
    [row] = await db
      .update(servers)
      .set({
        ...input,
        ...(moved ? { hostKeyAlgo: null, hostKey: null, hostKeyFingerprint: null, status: "pending" as const, statusMessage: null, info: null, lastCheckedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(servers.id, s.id))
      .returning();
  } catch (e) {
    throw duplicateError(e) ?? e;
  }
  const next = row!;
  const changes = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== s[k as keyof typeof s]));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "server.updated",
    targetType: "server",
    targetId: s.id,
    details: { name: next.name, changes, verificationReset: moved },
  });
  await publish(session.workspaceId, { type: "server.updated", serverId: s.id, status: next.status });
  return { server: serverDTO(next) };
});

/** Remove a server. Owner, with a fresh password + 2FA confirmation. Refused while apps still live on it. */
export const DELETE = route<{ id: string }>("OWNER", async ({ session, params }) => {
  const s = await loadServer(session.workspaceId, params.id);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(apps).where(eq(apps.serverId, s.id));
  if (n > 0) throw new HttpError(409, "Remove this server's apps first", { code: "server_has_apps", count: n });
  await requireStepUp(session);
  await db.delete(servers).where(eq(servers.id, s.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "server.removed",
    targetType: "server",
    targetId: s.id,
    details: { name: s.name, host: s.host, baseDomain: s.baseDomain, fingerprint: s.hostKeyFingerprint },
  });
  await publish(session.workspaceId, { type: "server.updated", serverId: s.id, status: s.status });
  return { ok: true };
});
