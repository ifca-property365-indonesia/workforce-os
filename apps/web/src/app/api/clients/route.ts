import { desc, eq } from "drizzle-orm";
import { audit, clients, db, projects } from "@wfos/db";
import { clientInputSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const cs = await db.select().from(clients).where(eq(clients.workspaceId, session.workspaceId)).orderBy(desc(clients.createdAt));
  const ps = await db.select().from(projects).where(eq(projects.workspaceId, session.workspaceId));
  return { clients: cs.map((c) => ({ ...c, projects: ps.filter((p) => p.clientId === c.id) })) };
});

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, clientInputSchema);
  const [c] = await db.insert(clients).values({ ...input, workspaceId: session.workspaceId }).returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.created", targetType: "client", targetId: c!.id, details: { name: c!.name } });
  return { client: c };
});
