import { and, eq } from "drizzle-orm";
import { db, projects } from "@wfos/db";
import { projectInputSchema } from "@wfos/shared";
import { notFound, patchBody, route } from "@/lib/server/route";
import { assertWorkspaceTeam } from "@/lib/server/teams";

type P = { id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edit a project. A change to its status (health, next milestone, next step) stamps statusUpdatedAt. */
export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await patchBody(req, projectInputSchema.omit({ clientId: true }).partial());
  if (!UUID.test(params.id)) notFound();
  const mine = and(eq(projects.id, params.id), eq(projects.workspaceId, session.workspaceId));
  const [before] = await db.select().from(projects).where(mine);
  if (!before) notFound();
  if (input.teamId) await assertWorkspaceTeam(session.workspaceId, input.teamId);
  const statusChanged =
    (input.health !== undefined && input.health !== before.health) ||
    (input.nextMilestone !== undefined && input.nextMilestone !== before.nextMilestone) ||
    (input.nextStep !== undefined && input.nextStep !== before.nextStep);
  const [p] = await db
    .update(projects)
    .set({ ...input, ...(statusChanged ? { statusUpdatedAt: new Date() } : {}) })
    .where(mine)
    .returning();
  return { project: p ?? notFound() };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  if (!UUID.test(params.id)) notFound();
  await db.delete(projects).where(and(eq(projects.id, params.id), eq(projects.workspaceId, session.workspaceId)));
  return { ok: true };
});
