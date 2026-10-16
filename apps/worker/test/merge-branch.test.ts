import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentWorkOnRepository, approvals, db, MERGE_TOOL, repositories, tasks } from "@wfos/db";
import { executeAction } from "../src/tools/actions";
import { afterApprovalResolved, executeApproval } from "../src/runner/approvals";
import { unmergedWork, unmergedWorkNote } from "../src/runner/merge-scan";
import { mirrorPath, syncMirror, type RepoRef } from "../src/runner/workspace/git";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";

/**
 * Merging a task's pushed work into the default branch, against a local bare repository as the remote: fast-forward,
 * merge commit, conflicts (nothing pushed), already merged, and work merged by hand found by the scan.
 * The agent's commits are made in a plain clone and put into the mirror the way exportAgentBranch does (refs/agent/<task>).
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), "wfos-merge-"));
const remote = path.join(tmp, "remote.git");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, env: ENV }).toString().trim();

let ws: Awaited<ReturnType<typeof makeWorkspace>>;
let emp: Awaited<ReturnType<typeof makeEmployee>>;
let repo: RepoRef;
let initial = "";

/** an agent branch off `from` with one commit writing `file`, exported to the mirror and "pushed" (an executed git_push) */
async function agentWork(name: string, from: string, file: string, content: string) {
  const task = await makeTask(ws.id, emp.id, { repositoryId: repo.id, status: "DONE", title: name });
  const dir = path.join(tmp, `work-${task.id}`);
  g(["clone", "-q", remote, dir]);
  g(["checkout", "-q", "-b", `agent/${task.id}`, from], dir);
  writeFileSync(path.join(dir, file), content);
  g(["add", "-A"], dir);
  g(["commit", "-q", "-m", name], dir);
  const head = g(["rev-parse", "HEAD"], dir);
  g(["push", "-q", mirrorPath(repo.id), `HEAD:refs/agent/${task.id}`], dir);
  g(["push", "-q", remote, `HEAD:refs/heads/agent/${task.id}`], dir);
  await db.insert(approvals).values({ workspaceId: ws.id, taskId: task.id, employeeId: emp.id, toolName: "git_push", title: "push", payload: { repositoryId: repo.id, head, branch: `agent/${task.id}` }, status: "EXECUTED" });
  return { task, head };
}

const remoteMain = () => g(["--git-dir", remote, "rev-parse", "refs/heads/main"]);
const merge = (taskId: string, head: string) => executeAction(ws.id, "merge_branch", { repositoryId: repo.id, head, title: "work" }, { taskId });

beforeAll(async () => {
  g(["init", "--bare", "-q", "-b", "main", remote]);
  const seed = path.join(tmp, "seed");
  g(["init", "-q", "-b", "main", seed]);
  writeFileSync(path.join(seed, "README.md"), "line1\nline2\n");
  g(["add", "-A"], seed);
  g(["commit", "-q", "-m", "initial"], seed);
  g(["push", "-q", remote, "main"], seed);
  initial = g(["rev-parse", "HEAD"], seed);
  ws = await makeWorkspace();
  emp = await makeEmployee(ws.id);
  const [row] = await db.insert(repositories).values({ workspaceId: ws.id, name: "app", provider: "git", url: remote, defaultBranch: "main" }).returning();
  repo = { id: row!.id, provider: "git", url: remote, defaultBranch: "main", token: null };
  await syncMirror(repo);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("merge_branch", () => {
  it("fast-forwards the default branch when it has not moved", async () => {
    const a = await agentWork("feature A", initial, "a.txt", "a\n");
    expect((await agentWorkOnRepository(ws.id, repo.id, { taskIds: [a.task.id] }))[0]!.state).toBe("unmerged");
    const r = await merge(a.task.id, a.head);
    expect(r.ok, r.summary).toBe(true);
    expect(r.details).toMatchObject({ fastForward: true, commit: a.head });
    expect(remoteMain()).toBe(a.head);
  });

  it("writes a merge commit when the default branch moved, keeping both sides", async () => {
    const before = remoteMain();
    const b = await agentWork("feature B", initial, "b.txt", "b\n");
    const r = await merge(b.task.id, b.head);
    expect(r.ok, r.summary).toBe(true);
    const main = remoteMain();
    expect(r.details).toMatchObject({ fastForward: false, commit: main });
    expect(g(["--git-dir", remote, "log", "-1", "--format=%P", main]).split(" ")).toEqual([before, b.head]);
    expect(g(["--git-dir", remote, "ls-tree", "--name-only", main]).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt"]);
    expect(g(["--git-dir", remote, "log", "-1", "--format=%an <%ae>|%s", main])).toBe(`Workforce OS <noreply@workforce-os.local>|Merge agent/${b.task.id}: work`);
  });

  it("reports conflicts and pushes nothing", async () => {
    const before = remoteMain();
    const c = await agentWork("conflicting README", initial, "README.md", "changed\n");
    // main changes README the other way first
    const d = await agentWork("README on main", before, "README.md", "other\n");
    expect((await merge(d.task.id, d.head)).ok).toBe(true);
    const moved = remoteMain();
    const r = await merge(c.task.id, c.head);
    expect(r.ok).toBe(false);
    expect(r.details).toMatchObject({ conflicts: ["README.md"] });
    expect(remoteMain()).toBe(moved);
  });

  it("says when the commit is already in the default branch", async () => {
    const [a] = (await agentWorkOnRepository(ws.id, repo.id)).filter((w) => w.title === "feature A");
    const r = await merge(a!.taskId, a!.head);
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ alreadyMerged: true });
  });

  it("runs from a person's approval and never charges the employee", async () => {
    const e = await agentWork("feature E", remoteMain(), "e.txt", "e\n");
    const [a] = await db
      .insert(approvals)
      .values({ workspaceId: ws.id, taskId: e.task.id, employeeId: emp.id, toolName: MERGE_TOOL, title: "merge", payload: { repositoryId: repo.id, head: e.head, branch: `agent/${e.task.id}`, title: "feature E" }, status: "APPROVED", decidedAt: new Date() })
      .returning();
    await executeApproval(a!.id);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(row!.status).toBe("EXECUTED");
    expect(remoteMain()).toBe(e.head);
    const [w] = await agentWorkOnRepository(ws.id, repo.id, { taskIds: [e.task.id] });
    expect(w!.state).toBe("merged");
  });

  it("finds work merged by hand and lists the rest for the next task", async () => {
    const f = await agentWork("merged by hand", remoteMain(), "f.txt", "f\n");
    g(["--git-dir", remote, "update-ref", "refs/heads/main", f.head]);
    const left = await unmergedWork(ws.id, repo, { sync: true });
    expect(left.map((w) => w.title)).toEqual(["conflicting README"]);
    const [w] = await agentWorkOnRepository(ws.id, repo.id, { taskIds: [f.task.id] });
    expect(w).toMatchObject({ state: "merged", decision: { detected: true } });
    // a second scan adds no second row
    await unmergedWork(ws.id, repo, { sync: true });
    expect(await db.select().from(approvals).where(and(eq(approvals.taskId, f.task.id), eq(approvals.toolName, MERGE_TOOL)))).toHaveLength(1);

    const next = await makeTask(ws.id, emp.id, { repositoryId: repo.id });
    const note = await unmergedWorkNote(ws.id, repo, next.id);
    expect(note).toContain("not in main yet");
    expect(note).toContain('"conflicting README"');
    expect(note).not.toContain("feature B");
  });

  it("a failed merge does not fail the task when its later actions resolve", async () => {
    // the conflict-fix flow: merge failed, the task went back to the employee, who pushed again and now waits
    const t = await makeTask(ws.id, emp.id, { repositoryId: repo.id, status: "AWAITING_APPROVAL" });
    await db.insert(approvals).values([
      { workspaceId: ws.id, taskId: t.id, employeeId: emp.id, toolName: MERGE_TOOL, title: "merge", payload: { repositoryId: repo.id, head: "x" }, status: "FAILED", executionResult: { ok: false, summary: "conflicts" } },
      { workspaceId: ws.id, taskId: t.id, employeeId: emp.id, toolName: "send_email", title: "mail", payload: {}, status: "EXECUTED", executionResult: { ok: true, summary: "sent" } },
    ]);
    await afterApprovalResolved(t.id);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(row!.status).toBe("DONE");
    expect(row!.result).not.toContain("conflicts");
  });

  it("a skipped version no longer counts as waiting", async () => {
    const [c] = (await agentWorkOnRepository(ws.id, repo.id)).filter((w) => w.title === "conflicting README");
    await db.insert(approvals).values({ workspaceId: ws.id, taskId: c!.taskId, employeeId: emp.id, toolName: MERGE_TOOL, title: "skip", payload: { repositoryId: repo.id, head: c!.head }, status: "REJECTED", decidedAt: new Date() });
    expect(await unmergedWork(ws.id, repo)).toEqual([]);
    const next = await makeTask(ws.id, emp.id, { repositoryId: repo.id });
    expect(await unmergedWorkNote(ws.id, repo, next.id)).toBe("");
  });
});
