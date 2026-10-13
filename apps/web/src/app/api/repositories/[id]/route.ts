import { and, eq } from "drizzle-orm";
import { audit, db, repositories } from "@wfos/db";
import { repositoryUpdateSchema } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { assertRepositoryUrl, publicRepo } from "@/lib/server/repositories";
import { notFound, patchBody, route } from "@/lib/server/route";

/** Change the clone URL, default branch or token (a new one, or null to remove it). The provider stays. */
export const PATCH = route<{ id: string }>("OWNER", async ({ session, req, params }) => {
  const [r] = await db.select().from(repositories).where(and(eq(repositories.id, params.id), eq(repositories.workspaceId, session.workspaceId)));
  if (!r) notFound("repository_not_found");
  const input = await patchBody(req, repositoryUpdateSchema);
  if (input.url !== undefined) await assertRepositoryUrl(session.workspaceId, r.provider, input.url);
  const set: Partial<typeof repositories.$inferInsert> = { updatedAt: new Date() };
  if (input.url !== undefined) set.url = input.url;
  if (input.defaultBranch !== undefined) set.defaultBranch = input.defaultBranch;
  if (input.token !== undefined) set.tokenEnc = input.token === null ? null : encryptSecret(input.token);
  const [next] = await db.update(repositories).set(set).where(eq(repositories.id, r.id)).returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "repository.updated",
    targetType: "repository",
    targetId: r.id,
    details: {
      name: r.name,
      ...(input.url !== undefined && input.url !== r.url ? { url: { from: r.url, to: input.url } } : {}),
      ...(input.defaultBranch !== undefined && input.defaultBranch !== r.defaultBranch ? { defaultBranch: { from: r.defaultBranch, to: input.defaultBranch } } : {}),
      ...(input.token !== undefined ? { token: input.token === null ? "removed" : `…${input.token.slice(-4)}` } : {}),
    },
  });
  return { repository: publicRepo(next!) };
});

export const DELETE = route<{ id: string }>("OWNER", async ({ session, params }) => {
  const [r] = await db.delete(repositories).where(and(eq(repositories.id, params.id), eq(repositories.workspaceId, session.workspaceId))).returning();
  if (!r) notFound("repository_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "repository.removed", targetType: "repository", targetId: r.id, details: { name: r.name } });
  return { ok: true };
});
