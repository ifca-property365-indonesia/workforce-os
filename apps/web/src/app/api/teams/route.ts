import { eq, desc } from "drizzle-orm";
import { audit, db, teamMembers, teams } from "@wfos/db";
import { teamInputSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const ts = await db.select().from(teams).where(eq(teams.workspaceId, session.workspaceId)).orderBy(desc(teams.createdAt));
  const ms = await db.select().from(teamMembers);
  return { teams: ts.map((t) => ({ ...t, memberIds: ms.filter((m) => m.teamId === t.id).map((m) => m.employeeId) })) };
});

export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, teamInputSchema);
  const [t] = await db.insert(teams).values({ workspaceId: session.workspaceId, name: input.name, description: input.description, leadId: input.leadId }).returning();
  const ids = [...new Set([...(input.leadId ? [input.leadId] : []), ...input.memberIds])];
  if (ids.length) await db.insert(teamMembers).values(ids.map((employeeId) => ({ teamId: t!.id, employeeId })));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "team.created", targetType: "team", targetId: t!.id, details: input });
  return { team: t };
});
