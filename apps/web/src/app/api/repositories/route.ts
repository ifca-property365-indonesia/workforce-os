import { and, desc, eq } from "drizzle-orm";
import { audit, db, repositories } from "@wfos/db";
import { repositoryInputSchema } from "@wfos/shared";
import { encryptSecret, decryptSecret } from "@wfos/shared/server";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

type Row = typeof repositories.$inferSelect;

/** What the browser may see: never the token, only whether one is set and its last 4 characters. */
export function publicRepo(r: Row) {
  const token = r.tokenEnc ? decryptSecret(r.tokenEnc) : null;
  return { id: r.id, name: r.name, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, tokenSet: !!token, tokenLast4: token ? token.slice(-4) : null, createdAt: r.createdAt };
}

export const GET = route("MEMBER", async ({ session }) => {
  const rows = await db.select().from(repositories).where(eq(repositories.workspaceId, session.workspaceId)).orderBy(desc(repositories.createdAt));
  return { repositories: rows.map(publicRepo) };
});

export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, repositoryInputSchema);
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
