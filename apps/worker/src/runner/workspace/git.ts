import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../../lib/env";
import { runInSandbox } from "./exec";
import type { SandboxHost } from "./layout";

const exec = promisify(execFile);

/**
 * Git delivery for Workspace mode.
 *
 * The worker runs as root, so it never runs git inside the agent's repository (repo-local config, hooks,
 * fsmonitor or filter drivers would execute as root). Instead:
 *  - the platform keeps a bare mirror per repository (only ever written by the platform);
 *  - cloning/refreshing the task workspace happens INSIDE the sandbox, with the mirror mounted read-only;
 *  - the agent's commits leave the sandbox as a git bundle on stdout (data only: no config, no hooks);
 *  - the worker fetches the bundle into the mirror, computes the diff there, and pushes the exact approved
 *    commit from the mirror with the platform's token (never visible to the agent).
 */

export interface RepoRef {
  id: string;
  provider: "github" | "gitlab" | "git";
  url: string;
  defaultBranch: string;
  token: string | null;
}

export interface BranchExport {
  branch: string;
  base: string;
  head: string;
  commits: { sha: string; subject: string }[];
  files: { path: string; added: number; removed: number }[];
  diff: string;
  diffTruncated: boolean;
  mergeable: boolean;
  conflicts: string[];
}

const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_DIFF = 400 * 1024;
export const UPSTREAM_IN_SANDBOX = "/mnt/wfos/upstream.git";

export function agentBranch(taskId: string): string {
  return `agent/${taskId}`;
}

export function mirrorPath(repoId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(repoId)) throw new Error("bad repository id");
  return path.join(env.storageDir, "repos", `${repoId}.git`);
}

/** Auth header for the provider, passed through GIT_CONFIG_* env (never on the command line or on disk). */
function authEnv(repo: RepoRef): Record<string, string> {
  if (!repo.token || !/^https:\/\//.test(repo.url)) return {};
  const user = repo.provider === "gitlab" ? "oauth2" : "x-access-token";
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${repo.token}`).toString("base64")}`,
  };
}

/** git as root on a platform-owned repository only: no system/global config, no hooks, no prompts. */
async function rootGit(args: string[], o: { cwd?: string; env?: Record<string, string>; maxBuffer?: number } = {}): Promise<string> {
  const r = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: o.cwd,
    maxBuffer: o.maxBuffer ?? 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", HOME: "/nonexistent", ...o.env },
  });
  return r.stdout;
}

/** Create or refresh the platform mirror from the remote. */
export async function syncMirror(repo: RepoRef): Promise<string> {
  if (!SAFE_REF.test(repo.defaultBranch)) throw new Error("invalid default branch name");
  const dir = mirrorPath(repo.id);
  const exists = await stat(path.join(dir, "HEAD")).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o755 });
    await rootGit(["clone", "--bare", "--quiet", repo.url, dir], { env: authEnv(repo) });
  } else {
    await rootGit(["-C", dir, "fetch", "--quiet", "--prune", repo.url, "+refs/heads/*:refs/heads/*"], { env: authEnv(repo) });
  }
  return dir;
}

/**
 * Inside the sandbox: clone the mirror into the empty workspace on branch agent/<task>, or (follow-ups)
 * refresh upstream/<default> so the agent can rebase onto the latest code.
 */
export async function prepareTaskRepo(o: { workspaceId: string; taskId: string; repo: RepoRef; host?: SandboxHost }): Promise<void> {
  const branch = agentBranch(o.taskId);
  const def = o.repo.defaultBranch;
  if (!SAFE_REF.test(def)) throw new Error("invalid default branch name");
  const script = [
    "set -e",
    "if [ ! -d .git ]; then",
    `  git clone --quiet --no-hardlinks --origin upstream ${UPSTREAM_IN_SANDBOX} .`,
    `  git checkout --quiet -B '${branch}' 'upstream/${def}' 2>/dev/null || git checkout --quiet -b '${branch}'`,
    "fi",
    `git fetch --quiet upstream '+refs/heads/${def}:refs/remotes/upstream/${def}'`,
  ].join("\n");
  const r = await runInSandbox({
    workspaceId: o.workspaceId,
    taskId: o.taskId,
    command: script,
    egressAllow: [],
    host: o.host,
    extraBinds: [{ host: mirrorPath(o.repo.id), sandbox: UPSTREAM_IN_SANDBOX }],
    timeoutSec: 300,
  });
  if (r.exitCode !== 0) throw new Error(`could not prepare the repository: ${r.output.trim().slice(-400)}`);
}

/**
 * Take the agent's commits out of the sandbox as a bundle and import them into the mirror as
 * refs/agent/<task>. Returns null when there is nothing new to deliver.
 */
export async function exportAgentBranch(o: { workspaceId: string; taskId: string; repo: RepoRef; host?: SandboxHost }): Promise<BranchExport | null> {
  const branch = agentBranch(o.taskId);
  const def = o.repo.defaultBranch;
  const mirror = mirrorPath(o.repo.id);
  const r = await runInSandbox({
    workspaceId: o.workspaceId,
    taskId: o.taskId,
    command: `git bundle create - '${branch}' --not 'upstream/${def}'`,
    egressAllow: [],
    host: o.host,
    rawStdout: true,
    timeoutSec: 300,
  });
  if (r.exitCode !== 0) {
    if (/empty bundle/i.test(r.output)) return null;
    throw new Error(`could not export the branch: ${r.output.trim().slice(-400)}`);
  }
  const dir = path.join(env.storageDir, "deliveries", o.taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const bundle = path.join(dir, `${Date.now()}.bundle`);
  await writeFile(bundle, r.stdout, { mode: 0o600 });
  // a bundle is plain object data: fetching it into the platform mirror runs nothing from the agent
  await rootGit(["-C", mirror, "bundle", "verify", "--quiet", bundle]);
  await rootGit(["-C", mirror, "fetch", "--quiet", bundle, `+${branch}:refs/agent/${o.taskId}`]);
  return describeAgentBranch(o.repo, o.taskId);
}

export async function describeAgentBranch(repo: RepoRef, taskId: string): Promise<BranchExport> {
  const mirror = mirrorPath(repo.id);
  const ref = `refs/agent/${taskId}`;
  const def = `refs/heads/${repo.defaultBranch}`;
  const head = (await rootGit(["-C", mirror, "rev-parse", ref])).trim();
  const base = (await rootGit(["-C", mirror, "merge-base", def, ref])).trim();
  const commits = (await rootGit(["-C", mirror, "log", "--format=%H%x09%s", `${base}..${ref}`]))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
  const files = (await rootGit(["-C", mirror, "diff", "--no-ext-diff", "--no-textconv", "--numstat", base, ref]))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split("\t");
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(d) || 0 };
    });
  let diff = await rootGit(["-C", mirror, "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, ref], { maxBuffer: 256 * 1024 * 1024 });
  const diffTruncated = diff.length > MAX_DIFF;
  if (diffTruncated) diff = diff.slice(0, MAX_DIFF);
  // would it merge cleanly into the default branch right now?
  let mergeable = true;
  let conflicts: string[] = [];
  try {
    await rootGit(["-C", mirror, "merge-tree", "--write-tree", "--name-only", "--no-messages", def, ref]);
  } catch (e) {
    mergeable = false;
    const out = String((e as { stdout?: string }).stdout ?? "");
    conflicts = out.trim().split("\n").slice(1).filter(Boolean);
  }
  return { branch: agentBranch(taskId), base, head, commits, files, diff, diffTruncated, mergeable, conflicts };
}

/** Push exactly the approved commit to agent/<task> on the remote (that branch belongs to the platform). */
export async function pushAgentBranch(repo: RepoRef, taskId: string, approvedHead: string): Promise<{ ok: boolean; summary: string }> {
  if (!/^[0-9a-f]{40}$/.test(approvedHead)) return { ok: false, summary: "invalid commit id" };
  const mirror = mirrorPath(repo.id);
  const current = (await rootGit(["-C", mirror, "rev-parse", `refs/agent/${taskId}`]).catch(() => "")).trim();
  if (current !== approvedHead) {
    return { ok: false, summary: `the branch changed after approval (approved ${approvedHead.slice(0, 8)}, now ${current.slice(0, 8) || "missing"}); nothing was pushed` };
  }
  try {
    await rootGit(["-C", mirror, "push", "--quiet", repo.url, `+${approvedHead}:refs/heads/${agentBranch(taskId)}`], { env: authEnv(repo) });
    return { ok: true, summary: `Pushed ${approvedHead.slice(0, 8)} to ${agentBranch(taskId)} (git hooks disabled)` };
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message).replace(/Authorization: [^\s]+ [^\s]+/g, "Authorization: ***");
    return { ok: false, summary: `push failed: ${msg.trim().slice(-500)}` };
  }
}

export type ProviderFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Open a pull/merge request from agent/<task> into the default branch with the platform's token. */
export async function createPullRequest(
  repo: RepoRef,
  p: { taskId: string; title: string; body: string; base?: string },
  fetchImpl: ProviderFetch = fetch as unknown as ProviderFetch,
): Promise<{ ok: boolean; summary: string; url?: string }> {
  if (!repo.token) return { ok: false, summary: "the repository has no token for opening pull requests" };
  const u = new URL(repo.url);
  const slug = u.pathname.replace(/^\//, "").replace(/\.git$/, "");
  const base = p.base ?? repo.defaultBranch;
  const head = agentBranch(p.taskId);
  if (repo.provider === "github") {
    const r = await fetchImpl(`https://api.github.com/repos/${slug}/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer ${repo.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "workforce-os" },
      body: JSON.stringify({ title: p.title, body: p.body, head, base }),
    });
    const j = (await r.json()) as { html_url?: string; message?: string };
    return r.ok ? { ok: true, summary: `Opened ${j.html_url}`, url: j.html_url } : { ok: false, summary: `GitHub refused the pull request (${r.status}): ${j.message ?? ""}` };
  }
  if (repo.provider === "gitlab") {
    const r = await fetchImpl(`${u.origin}/api/v4/projects/${encodeURIComponent(slug)}/merge_requests`, {
      method: "POST",
      headers: { "private-token": repo.token, "content-type": "application/json" },
      body: JSON.stringify({ source_branch: head, target_branch: base, title: p.title, description: p.body }),
    });
    const j = (await r.json()) as { web_url?: string; message?: unknown };
    return r.ok ? { ok: true, summary: `Opened ${j.web_url}`, url: j.web_url } : { ok: false, summary: `GitLab refused the merge request (${r.status}): ${JSON.stringify(j.message ?? "")}` };
  }
  return { ok: false, summary: "pull requests are supported for GitHub and GitLab repositories" };
}
