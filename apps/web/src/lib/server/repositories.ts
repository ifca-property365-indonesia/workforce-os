import "server-only";
import { eq } from "drizzle-orm";
import { db, servers, type repositories } from "@wfos/db";
import { repositoryUrlProblem, type RepositoryProvider } from "@wfos/shared";
import { decryptSecret } from "@wfos/shared/server";
import { HttpError } from "./auth";

/**
 * A repository URL must be a clone URL at its provider, and never an address served by one of the workspace's app
 * servers (an app preview pasted in place of the repository: the first preview test did exactly that).
 */
export async function assertRepositoryUrl(workspaceId: string, provider: RepositoryProvider, url: string): Promise<void> {
  const problem = repositoryUrlProblem(provider, url);
  if (problem) throw new HttpError(400, problem, { code: "repository_url_invalid" });
  const host = new URL(url).hostname.toLowerCase();
  const domains = await db.select({ baseDomain: servers.baseDomain }).from(servers).where(eq(servers.workspaceId, workspaceId));
  if (domains.some(({ baseDomain }) => host === baseDomain || host.endsWith(`.${baseDomain}`))) {
    throw new HttpError(400, "This is an app preview address, not a repository: use the repository's clone URL", { code: "repository_url_is_preview" });
  }
}
type Row = typeof repositories.$inferSelect;

/** What the browser may see: never the token, only whether one is set and its last 4 characters. */
export function publicRepo(r: Row) {
  const token = r.tokenEnc ? decryptSecret(r.tokenEnc) : null;
  return { id: r.id, name: r.name, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, tokenSet: !!token, tokenLast4: token ? token.slice(-4) : null, createdAt: r.createdAt };
}

