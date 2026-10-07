import { and, eq } from "drizzle-orm";
import { audit, db, teamMembers, teams } from "@wfos/db";
import { teamInputSchema } from "@wfos/shared";
import { notFound, patchBody, route } from "@/lib/server/route";

type P = { id: string };

export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const input = await patchBody(req, teamInputSchema.partial());
  const [t] = await db
    .update(teams)
    .set({ ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.leadId !== undefined ? { leadId: input.leadId } : {}) })
    .where(and(eq(teams.id, params.id), eq(teams.workspaceId, session.workspaceId)))
    .returning();
  if (!t) notFound();
  if (input.memberIds) {
    await db.delete(teamMembers).where(eq(teamMembers.teamId, t.id));
    const ids = [...new Set([...(t.leadId ? [t.leadId] : []), ...input.memberIds])];
    if (ids.length) await db.insert(teamMembers).values(ids.map((employeeId) => ({ teamId: t.id, employeeId })));
  }
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "team.updated", targetType: "team", targetId: t.id, details: input });
  return { team: t };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  await db.delete(teams).where(and(eq(teams.id, params.id), eq(teams.workspaceId, session.workspaceId)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "team.deleted", targetType: "team", targetId: params.id });
  return { ok: true };
});
