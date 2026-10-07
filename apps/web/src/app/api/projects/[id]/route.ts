import { and, eq } from "drizzle-orm";
import { db, projects } from "@wfos/db";
import { projectInputSchema } from "@wfos/shared";
import { notFound, patchBody, route } from "@/lib/server/route";

type P = { id: string };

export const PATCH = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await patchBody(req, projectInputSchema.omit({ clientId: true }).partial());
  const [p] = await db.update(projects).set(input).where(and(eq(projects.id, params.id), eq(projects.workspaceId, session.workspaceId))).returning();
  return { project: p ?? notFound() };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  await db.delete(projects).where(and(eq(projects.id, params.id), eq(projects.workspaceId, session.workspaceId)));
  return { ok: true };
});
