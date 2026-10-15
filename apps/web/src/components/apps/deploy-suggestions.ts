import type { ReleaseDTO } from "@wfos/shared";

/** A branch the Deploy dialog offers, with the newest preview release made from it (null: the default, never deployed). */
export interface BranchSuggestion {
  branch: string;
  latest: ReleaseDTO | null;
  isDefault: boolean;
}

export interface DeploySuggestions {
  /** the branch the dialog starts on: the newest preview release's (an agent's branch until it is merged), else the app's */
  initialBranch: string;
  /** newest first, at most `maxBranches`; the app's default branch is always there */
  branches: BranchSuggestion[];
  /** commits that ran in the preview, newest first, one row each: the exact-commit mode picks from these */
  commits: ReleaseDTO[];
}

/**
 * What the Deploy dialog suggests, from the app's releases (any order, both environments). The preview releases
 * only: an agent's work reaches the preview on its own branch (agent/<task id>) and stays there until someone merges
 * it, so "the latest commit of the app's branch" can be older than what the preview showed last (the third Delivery
 * trial: a manual deploy of main brought back v5 over the agent's v2).
 */
export function deploySuggestions(releases: ReleaseDTO[], defaultBranch: string, maxBranches = 4, maxCommits = 6): DeploySuggestions {
  const preview = releases.filter((r) => r.environmentKind === "preview").sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const byBranch = new Map<string, ReleaseDTO>();
  for (const r of preview) if (r.branch && !byBranch.has(r.branch)) byBranch.set(r.branch, r);
  let branches: BranchSuggestion[] = [...byBranch].map(([branch, latest]) => ({ branch, latest, isDefault: branch === defaultBranch }));
  if (branches.length > maxBranches) {
    const head = branches.slice(0, maxBranches);
    const def = branches.find((b) => b.isDefault);
    branches = def && !head.includes(def) ? [...head.slice(0, maxBranches - 1), def] : head;
  }
  if (!branches.some((b) => b.isDefault)) branches.push({ branch: defaultBranch, latest: null, isDefault: true });
  const seen = new Set<string>();
  const commits: ReleaseDTO[] = [];
  for (const r of preview) {
    if (!/^[0-9a-f]{40}$/.test(r.commit) || seen.has(r.commit)) continue;
    seen.add(r.commit);
    commits.push(r);
    if (commits.length >= maxCommits) break;
  }
  return { initialBranch: preview[0]?.branch || defaultBranch, branches, commits };
}
