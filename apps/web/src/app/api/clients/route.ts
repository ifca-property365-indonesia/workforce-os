import { desc, eq } from "drizzle-orm";
import { audit, clients, db } from "@wfos/db";
import { clientInputSchema, parseContacts } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { EMPTY_BILLING, assertClientCodeFree, billingSummaries, clientCodeConflict, projectsWithHealth, workspaceTimeZone } from "@/lib/server/clients";

export const GET = route("VIEWER", async ({ session }) => {
  const tz = await workspaceTimeZone(session.workspaceId);
  const [cs, withHealth, billing] = await Promise.all([
    db.select().from(clients).where(eq(clients.workspaceId, session.workspaceId)).orderBy(desc(clients.createdAt)),
    projectsWithHealth(session.workspaceId, tz),
    billingSummaries(session.workspaceId, tz),
  ]);
  return {
    timezone: tz,
    clients: cs.map((c) => ({
      ...c,
      contacts: parseContacts(c.contacts),
      projects: withHealth.filter((p) => p.clientId === c.id),
      ...(billing.get(c.id) ?? EMPTY_BILLING),
    })),
  };
});

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, clientInputSchema);
  await assertClientCodeFree(session.workspaceId, input.code);
  const [c] = await db
    .insert(clients)
    .values({ ...input, workspaceId: session.workspaceId })
    .returning()
    .catch((e) => clientCodeConflict(e, input.code));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.created", targetType: "client", targetId: c!.id, details: { name: c!.name, code: c!.code } });
  return { client: { ...c!, contacts: parseContacts(c!.contacts) } };
});
