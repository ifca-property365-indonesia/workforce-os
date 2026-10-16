import { and, eq } from "drizzle-orm";
import { agentWorkOnRepository, db, repositories } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";

/**
 * Pushed agent work on this repository that is not in its default branch yet (or whose merge is under way or failed),
 * newest first. Asks the worker to refresh the mirror, so work merged outside Workforce OS drops off shortly after.
 */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [repo] = await db
    .select({ id: repositories.id, name: repositories.name, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(and(eq(repositories.id, params.id), eq(repositories.workspaceId, session.workspaceId)));
  if (!repo) notFound();
  const work = (await agentWorkOnRepository(session.workspaceId, repo.id)).filter((w) => w.state !== "merged" && w.state !== "skipped");
  if (work.some((w) => w.state === "unmerged" || w.state === "failed")) await q.mergeScan(session.workspaceId, repo.id).catch(() => {});
  return {
    repository: repo,
    work: work.map((w) => ({
      taskId: w.taskId,
      parentTaskId: w.parentTaskId,
      title: w.title,
      branch: w.branch,
      head: w.head,
      pushedAt: w.pushedAt,
      state: w.state,
      summary: w.decision?.summary ?? null,
      conflicts: w.decision?.conflicts ?? [],
    })),
  };
});
