import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { approvals, db, repositories, steps, tasks } from "@wfos/db";
import { notFound, route } from "@/lib/server/route";

const TEST_COMMAND = /\b(test|vitest|jest|pytest|mocha|go test|cargo test|phpunit|rspec)\b|\.test\.|\bspec\b/;

/** The code deliverable of a Workspace-mode task: branch, commits, files, diff, last test run and pending delivery approvals. */
export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, params.id), eq(tasks.workspaceId, session.workspaceId)));
  if (!t) notFound("task_not_found");
  const code = [...t.deliverables].reverse().find((d) => d.kind === "code" && d.meta && "branch" in d.meta) ?? null;
  const [repo] = t.repositoryId ? await db.select({ name: repositories.name, url: repositories.url, defaultBranch: repositories.defaultBranch }).from(repositories).where(eq(repositories.id, t.repositoryId)) : [];
  const outputs = await db
    .select({ input: steps.input, output: steps.output, status: steps.status, createdAt: steps.createdAt })
    .from(steps)
    .where(and(eq(steps.taskId, t.id), or(eq(steps.name, "bash_output"), like(steps.name, "bash_output%"))))
    .orderBy(desc(steps.createdAt))
    .limit(50);
  const lastTest = outputs.find((o) => TEST_COMMAND.test(String((o.input as { command?: string } | null)?.command ?? ""))) ?? null;
  const pending = await db
    .select({ id: approvals.id, toolName: approvals.toolName, title: approvals.title, status: approvals.status, createdAt: approvals.createdAt })
    .from(approvals)
    .where(and(eq(approvals.taskId, t.id), inArray(approvals.toolName, ["git_push", "create_pull_request", "bash"])))
    .orderBy(approvals.createdAt);
  return {
    task: { id: t.id, status: t.status, workspaceStatus: t.workspaceStatus, resumable: !!t.agentSessionId },
    repository: repo ?? null,
    code: code ? { ...code.meta, diff: code.content, createdAt: code.createdAt } : null,
    lastTest: lastTest ? { command: (lastTest.input as { command?: string }).command, output: lastTest.output, ok: lastTest.status === "ok", at: lastTest.createdAt } : null,
    approvals: pending,
  };
});
