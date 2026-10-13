import { and, desc, eq } from "drizzle-orm";
import { audit, db, repositories } from "@wfos/db";
import { repositoryInputSchema } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { HttpError } from "@/lib/server/auth";
import { assertRepositoryUrl, publicRepo } from "@/lib/server/repositories";
import { body, route } from "@/lib/server/route";

export const GET = route("MEMBER", async ({ session }) => {
  const rows = await db.select().from(repositories).where(eq(repositories.workspaceId, session.workspaceId)).orderBy(desc(repositories.createdAt));
  return { repositories: rows.map(publicRepo) };
});

export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, repositoryInputSchema);
  await assertRepositoryUrl(session.workspaceId, input.provider, input.url);
  const [exists] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.workspaceId, session.workspaceId), eq(repositories.name, input.name)));
  if (exists) throw new HttpError(409, "A repository with this name already exists", { code: "repository_exists" });
  const [r] = await db
    .insert(repositories)
    .values({ workspaceId: session.workspaceId, name: input.name, provider: input.provider, url: input.url, defaultBranch: input.defaultBranch, tokenEnc: input.token ? encryptSecret(input.token) : null })
    .returning();
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "repository.connected",
    targetType: "repository",
    targetId: r!.id,
    details: { name: r!.name, url: r!.url, provider: r!.provider, token: input.token ? `…${input.token.slice(-4)}` : null },
  });
  return { repository: publicRepo(r!) };
});
