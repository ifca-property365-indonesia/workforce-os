import { desc, eq } from "drizzle-orm";
import { audit, db, servers } from "@wfos/db";
import { serverInputSchema } from "@wfos/shared";
import { serverEnv } from "@/lib/server/env";
import { publish } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";
import { assertHostAllowed, assertUnique, duplicateError, serverDTO } from "@/lib/server/servers";

/** The workspace's app servers (no secrets) and whether private addresses are allowed on this instance. */
export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(servers).where(eq(servers.workspaceId, session.workspaceId)).orderBy(desc(servers.createdAt));
  return { servers: rows.map(serverDTO), allowPrivate: serverEnv.appServersAllowPrivate };
});

/** Register a server (status pending). It is used only after an Owner has verified its host key. */
export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, serverInputSchema);
  assertHostAllowed(input.host);
  await assertUnique(session.workspaceId, input);
  let row;
  try {
    [row] = await db
      .insert(servers)
      .values({ workspaceId: session.workspaceId, ...input, status: "pending", createdBy: session.userId })
      .returning();
  } catch (e) {
    throw duplicateError(e) ?? e;
  }
  const s = row!;
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "server.added",
    targetType: "server",
    targetId: s.id,
    details: { name: s.name, host: s.host, port: s.port, username: s.username, baseDomain: s.baseDomain, role: s.role },
  });
  await publish(session.workspaceId, { type: "server.updated", serverId: s.id, status: s.status });
  return { server: serverDTO(s) };
});
