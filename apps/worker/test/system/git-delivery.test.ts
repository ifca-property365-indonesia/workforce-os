import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, db, employees, repositories, tasks } from "@wfos/db";
import { buildTools, type RunContext } from "../../src/tools/registry";
import { executeApproval } from "../../src/runner/approvals";
import { setProviderFetch, executeAction } from "../../src/tools/actions";
import { prepareTaskRepo, syncMirror, type RepoRef } from "../../src/runner/workspace/git";
import { runInSandbox } from "../../src/runner/workspace/exec";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "../fixtures";
import { resetTransport, transport } from "../transport";
import { cleanupWorkspace, testHost } from "./host";

/**
 * Git delivery on real sandbox units with a local bare repository as the "remote" (no network):
 * the agent commits inside its sandbox, the platform exports, shows the diff, and pushes exactly the
 * approved commit. Hooks and repo config planted by the agent never run as root.
 */
const host = testHost();
const tmp = mkdtempSync(path.join(os.tmpdir(), "wfos-git-"));
const remote = path.join(tmp, "remote.git");
const ROOT_MARKER = `/var/tmp/wfos-pwned-${process.pid}`;
let wsId = "";
const created: string[] = [];

function g(args: string[], cwd?: string) {
  return execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
}

async function agent(taskId: string, command: string) {
  const r = await runInSandbox({ workspaceId: wsId, taskId, command: `git -c user.name=Agent -c user.email=agent@test ${command}`, egressAllow: [], host });
  expect(r.exitCode, r.output).toBe(0);
  return r;
}

async function setup() {
  const ws = await makeWorkspace();
  wsId = ws.id;
  created.push(ws.id);
  const emp = await makeEmployee(ws.id, { autonomyLevel: "QUEUE", toolPermissions: [{ tool: "git_push", enabled: true }, { tool: "create_pull_request", enabled: true }] });
  await db.update(employees).set({ executionMode: "workspace" }).where(eq(employees.id, emp.id));
  const [repoRow] = await db.insert(repositories).values({ workspaceId: ws.id, name: "app", provider: "git", url: remote, defaultBranch: "main" }).returning();
  const repo: RepoRef & { name: string } = { id: repoRow!.id, name: "app", provider: "git", url: remote, defaultBranch: "main", token: null };
  return { ws, emp, repo };
}

async function newTask(ws: { id: string }, emp: Awaited<ReturnType<typeof makeEmployee>>, repo: RepoRef & { name: string }) {
  const task = await makeTask(ws.id, emp.id, { repositoryId: repo.id, status: "RUNNING" });
  await syncMirror(repo);
  await prepareTaskRepo({ workspaceId: ws.id, taskId: task.id, repo, host });
  const ctx: RunContext = runContext(ws, { ...emp, executionMode: "workspace" } as never, task.id, { workspace: { egressDomains: [], repository: repo } });
  const push = buildTools(ctx).find((d) => d.name === "git_push")!;
  return { task, ctx, push };
}

beforeAll(() => {
  process.env.WFOS_RUNTIME_DIR = host.runtimeDir;
  process.env.WFOS_RUNNER_DIR = host.runnerDir;
  process.env.WFOS_NODE_PREFIX = host.nodePrefix;
  g(["init", "--bare", "-q", "-b", "main", remote]);
  const seed = path.join(tmp, "seed");
  g(["init", "-q", "-b", "main", seed]);
  execFileSync("sh", ["-c", "printf 'line1\\nline2\\n' > README.md"], { cwd: seed });
  g(["add", "-A"], seed);
  g(["commit", "-q", "-m", "initial"], seed);
  g(["push", "-q", remote, "main"], seed);
  resetTransport();
});
afterAll(async () => {
  setProviderFetch(null);
  for (const id of created) await cleanupWorkspace(host, id);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(ROOT_MARKER, { force: true });
});

describe("git delivery (real sandbox units, local remote)", () => {
  it("clones into the workspace on agent/<task>, exports the commit, shows the diff and pushes exactly the approved commit", async () => {
    const { ws, emp, repo } = await setup();
    const { task, ctx, push } = await newTask(ws, emp, repo);
    const branch = await agent(task.id, "rev-parse --abbrev-ref HEAD");
    expect(branch.output.trim()).toBe(`agent/${task.id}`);

    // the agent plants hooks and repo config that would run code if the platform ran git in this repo as root
    await runInSandbox({
      workspaceId: ws.id,
      taskId: task.id,
      egressAllow: [],
      host,
      command:
        `for h in pre-push post-checkout reference-transaction pre-commit post-merge; do printf '#!/bin/sh\\ntouch ${ROOT_MARKER}\\n' > .git/hooks/$h; chmod +x .git/hooks/$h; done; ` +
        `git config core.fsmonitor 'touch ${ROOT_MARKER}'; git config core.sshCommand 'touch ${ROOT_MARKER}'; ` +
        `printf 'hello\\n' > feature.txt && git add -A && git -c user.name=Agent -c user.email=agent@test commit -q -m 'Add feature'`,
    });

    const r = await push.handler({ summary: "Adds feature.txt" }, {});
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/approval/i) });
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(a!.toolName).toBe("git_push");
    const p = a!.payload as { head: string; commits: { subject: string }[]; files: { path: string }[]; diff: string; branch: string; hooksDisabled: boolean };
    expect(p.branch).toBe(`agent/${task.id}`);
    expect(p.commits.map((c) => c.subject)).toEqual(["Add feature"]);
    expect(p.files.map((f) => f.path)).toEqual(["feature.txt"]);
    expect(p.diff).toContain("+hello");
    expect(p.hooksDisabled).toBe(true);
    // nothing reached the remote before approval
    expect(() => g(["-C", remote, "rev-parse", `refs/heads/agent/${task.id}`])).toThrow();

    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    const [done] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(done!.status).toBe("EXECUTED");
    expect(g(["-C", remote, "rev-parse", `refs/heads/agent/${task.id}`])).toBe(p.head);
    // none of the planted hooks or config ran outside the sandbox
    expect(existsSync(ROOT_MARKER)).toBe(false);
    expect(ctx.deliverables.some((d) => d.kind === "code" && d.content.includes("+hello"))).toBe(true);
  });

  it("refuses to push when the branch changed after approval (exact approved commit only)", async () => {
    const { ws, emp, repo } = await setup();
    const { task, push } = await newTask(ws, emp, repo);
    await agent(task.id, "commit -q --allow-empty -m first");
    await push.handler({}, {});
    const [first] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await agent(task.id, "commit -q --allow-empty -m second");
    await push.handler({}, {}); // moves refs/agent/<task> in the mirror to the newer commit
    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, first!.id));
    await executeApproval(first!.id);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, first!.id));
    expect(after!.status).toBe("FAILED");
    expect((after!.executionResult as { summary: string }).summary).toMatch(/changed after approval/);
    expect(() => g(["-C", remote, "rev-parse", `refs/heads/agent/${task.id}`])).toThrow();
  });

  it("tells the agent to rebase instead of queueing a conflicting push", async () => {
    const { ws, emp, repo } = await setup();
    const { task, push } = await newTask(ws, emp, repo);
    await agent(task.id, "commit -q --allow-empty -m noop");
    await runInSandbox({ workspaceId: ws.id, taskId: task.id, egressAllow: [], host, command: "printf 'agent version\\n' > README.md && git add -A && git -c user.name=A -c user.email=a@t commit -q -m 'Agent edits README'" });
    // meanwhile someone changes the same line upstream
    const other = path.join(tmp, `other-${randomUUID()}`);
    g(["clone", "-q", remote, other]);
    execFileSync("sh", ["-c", "printf 'upstream version\\n' > README.md"], { cwd: other });
    g(["commit", "-q", "-am", "Upstream edits README"], other);
    g(["push", "-q", "origin", "main"], other);
    await syncMirror(repo);
    const r = await push.handler({}, {});
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/conflicts with main.*README\.md.*Rebase onto upstream\/main/s) });
    expect((await db.select().from(approvals).where(eq(approvals.taskId, task.id))).length).toBe(0);
  });

  it("returns a failed push to the employee as a follow-up step", async () => {
    const { ws, emp, repo } = await setup();
    const { task, push } = await newTask(ws, emp, repo);
    await agent(task.id, "commit -q --allow-empty -m change");
    await push.handler({}, {});
    const [a] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    // the remote goes away before the push
    await db.update(repositories).set({ url: path.join(tmp, "gone.git") }).where(eq(repositories.id, repo.id));
    await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, task.id));
    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a!.id));
    resetTransport();
    await executeApproval(a!.id);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t!.status).toBe("QUEUED");
    const q = transport.queued.find((x) => x.queue === "runs" && (x.data as { taskId: string }).taskId === task.id);
    expect((q!.data as { resumeNote: string }).resumeNote).toMatch(/Pushing your branch FAILED/);
  });

  it("opens a pull request with the platform token (provider API mocked)", async () => {
    const ws = await makeWorkspace();
    const [repoRow] = await db
      .insert(repositories)
      .values({ workspaceId: ws.id, name: "gh", provider: "github", url: "https://github.com/acme/app.git", defaultBranch: "main", tokenEnc: (await import("@wfos/shared/server")).encryptSecret("ghp_platformtoken000000000000000000000000") })
      .returning();
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    setProviderFetch(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/acme/app/pull/7" }) };
    });
    const taskId = randomUUID();
    const r = await executeAction(ws.id, "create_pull_request", { repositoryId: repoRow!.id, taskId, title: "Add feature", body: "Body", base: "main" });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/app/pulls");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer ghp_platformtoken000000000000000000000000");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ title: "Add feature", body: "Body", head: `agent/${taskId}`, base: "main" });
  });
});
