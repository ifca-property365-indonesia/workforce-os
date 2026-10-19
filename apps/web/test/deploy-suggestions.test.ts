import { describe, expect, it } from "vitest";
import type { ReleaseDTO } from "@wfos/shared";
import { deploySuggestions } from "@/components/apps/deploy-suggestions";

const sha = (c: string) => c.repeat(40).slice(0, 40);
function release(over: Partial<ReleaseDTO> & Pick<ReleaseDTO, "branch" | "commit" | "createdAt">): ReleaseDTO {
  return {
    id: `r-${over.commit}-${over.createdAt}`,
    appId: "app",
    environmentId: "env",
    environmentKind: "preview",
    promotedFromReleaseId: null,
    commitSubject: null,
    status: "superseded",
    trigger: "manual",
    step: null,
    warnings: [],
    error: null,
    approvalId: null,
    taskId: null,
    modules: null,
    createdByName: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe("Deploy dialog suggestions", () => {
  it("third trial (2026-10-15): starts on the agent's branch the preview ran last, not main (whose head was the old v5)", () => {
    const releases = [
      release({ branch: "main", commit: sha("7"), commitSubject: "v5: kolom suasana hati", createdAt: "2026-10-14T16:40:00Z" }),
      release({ branch: "agent/aaff3449", commit: sha("3"), commitSubject: "v2 frontend", createdAt: "2026-10-15T07:20:00Z", taskId: "t1", trigger: "approval" }),
      release({ branch: "agent/aaff3449", commit: sha("8"), commitSubject: "FE: clamp", createdAt: "2026-10-15T09:41:00Z", taskId: "t1", trigger: "approval", status: "deployed" }),
      // a live release never steers the preview's dialog
      release({ branch: "release/x", commit: sha("a"), createdAt: "2026-10-15T10:00:00Z", environmentKind: "live" }),
    ];
    const s = deploySuggestions(releases, "main");
    expect(s.initialBranch).toBe("agent/aaff3449");
    expect(s.branches.map((b) => [b.branch, b.latest?.commit ?? null, b.isDefault])).toEqual([
      ["agent/aaff3449", sha("8"), false],
      ["main", sha("7"), true],
    ]);
    expect(s.commits.map((r) => r.commit)).toEqual([sha("8"), sha("3"), sha("7")]);
  });

  it("once main is deployed again it starts on main; a repeated commit is listed once", () => {
    const s = deploySuggestions(
      [
        release({ branch: "agent/a", commit: sha("1"), createdAt: "2026-10-15T09:00:00Z" }),
        release({ branch: "main", commit: sha("7"), createdAt: "2026-10-15T09:48:00Z" }),
        release({ branch: "main", commit: sha("7"), createdAt: "2026-10-14T09:48:00Z", trigger: "rollback" }),
      ],
      "main",
    );
    expect(s.initialBranch).toBe("main");
    expect(s.commits.map((r) => r.commit)).toEqual([sha("7"), sha("1")]);
  });

  it("the trial's refused deploys of main (failed, no commit) do not count: main stays where its last real release was", () => {
    const s = deploySuggestions(
      [
        release({ branch: "agent/aaff3449", commit: sha("8"), createdAt: "2026-10-15T09:41:00Z", taskId: "t1" }),
        release({ branch: "main", commit: "", createdAt: "2026-10-15T10:25:25Z", status: "failed", error: "Commit 7543ad71 is the version running now" }),
        release({ branch: "main", commit: "", createdAt: "2026-10-15T10:27:32Z", status: "failed" }),
      ],
      "main",
    );
    expect(s.initialBranch).toBe("agent/aaff3449");
    expect(s.branches.map((b) => [b.branch, b.latest?.commit ?? null])).toEqual([
      ["agent/aaff3449", sha("8")],
      ["main", null],
    ]);
  });

  it("no releases yet: the app's branch alone; many branches: the newest ones and the default always kept", () => {
    expect(deploySuggestions([], "main")).toEqual({ initialBranch: "main", branches: [{ branch: "main", latest: null, isDefault: true }], commits: [] });
    const many = ["a", "b", "c", "d", "e"].map((x, i) => release({ branch: `agent/${x}`, commit: sha(String(i)), createdAt: `2026-10-15T0${i + 1}:00:00Z` }));
    const s = deploySuggestions([release({ branch: "main", commit: sha("f"), createdAt: "2026-10-14T00:00:00Z" }), ...many], "main", 4);
    expect(s.branches.map((b) => b.branch)).toEqual(["agent/e", "agent/d", "agent/c", "main"]);
  });
});
