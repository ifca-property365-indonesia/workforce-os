import { afterEach, describe, expect, it } from "vitest";
import { hasLicense, latestSkillCommit, parseSkillMd, resolveSkill, searchSkillsSh, setCatalogFetch, SkillCatalogError, skillHash } from "../src/skill-catalog";
import { fakeCatalog, sha, SKILL_MD } from "./fake-catalog";

afterEach(() => setCatalogFetch(null));

const md = SKILL_MD("pdf-tools", "Use for PDF work", "# PDF\n1. Run scripts/run.py");
const repo = () => ({
  head: sha("a"),
  commits: {
    [sha("a")]: {
      "README.md": "# repo",
      "skills/pdf-tools/SKILL.md": md,
      "skills/pdf-tools/scripts/run.py": "print('hi')",
      "skills/pdf-tools/logo.png": "PNG",
      "skills/other/SKILL.md": SKILL_MD("other", "x", "y"),
      "examples/pdf-tools/SKILL.md": SKILL_MD("pdf-tools", "old copy", "z"),
    } as Record<string, string>,
  } as Record<string, Record<string, string>>,
});

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e instanceof SkillCatalogError ? e.code : String(e);
  }
  return "resolved";
}

describe("skill catalog (C4)", () => {
  it("searches skills.sh: valid entries only, most installed first", async () => {
    const f = fakeCatalog({}, [
      { source: "acme/skills", skillId: "pdf-tools", installs: 10 },
      { source: "bad source", skillId: "x", installs: 999 },
      { source: "big/repo", skillId: "pdf", installs: 500 },
    ]);
    setCatalogFetch(f.fetchImpl);
    expect((await searchSkillsSh("pdf")).map((s) => `${s.source}:${s.skillId}`)).toEqual(["big/repo:pdf", "acme/skills:pdf-tools"]);
    expect(await searchSkillsSh("p")).toEqual([]);
  });

  it("resolves a skill at the head commit: skills/<id> preferred, frontmatter parsed, sibling text files fetched, hash of SKILL.md", async () => {
    setCatalogFetch(fakeCatalog({ "acme/skills": repo() }).fetchImpl);
    const r = await resolveSkill("acme/skills", "pdf-tools");
    expect(r).toMatchObject({ path: "skills/pdf-tools/SKILL.md", dir: "skills/pdf-tools", commit: sha("a"), license: "MIT", licenseFile: null, name: "pdf-tools", description: "Use for PDF work" });
    expect(r.body).toBe("# PDF\n1. Run scripts/run.py");
    expect(r.contentHash).toBe(skillHash(md));
    expect(r.files).toEqual([
      { path: "scripts/run.py", size: 11, content: "print('hi')" },
      { path: "logo.png", size: 3, content: null },
    ]);
    // inspecting does not fetch the files
    expect((await resolveSkill("acme/skills", "pdf-tools", { withFiles: false })).files.every((f) => f.content === null)).toBe(true);
  });

  it("pins a commit, and refuses private repositories, unknown skills and bad input", async () => {
    const r = repo();
    const f = fakeCatalog({ "acme/skills": r, "acme/private": { ...repo(), private: true } });
    setCatalogFetch(f.fetchImpl);
    r.commits[sha("b")] = { "skills/pdf-tools/SKILL.md": SKILL_MD("pdf-tools", "new", "v2") };
    r.head = sha("b");
    expect((await resolveSkill("acme/skills", "pdf-tools", { commit: sha("a") })).description).toBe("Use for PDF work");
    expect((await resolveSkill("acme/skills", "pdf-tools")).commit).toBe(sha("b"));
    expect(await codeOf(resolveSkill("acme/private", "pdf-tools"))).toBe("private");
    expect(await codeOf(resolveSkill("acme/skills", "nope"))).toBe("not_found");
    expect(await codeOf(resolveSkill("not a repo", "pdf-tools"))).toBe("invalid");
    expect(await codeOf(resolveSkill("acme/skills", "pdf-tools", { commit: "main" }))).toBe("invalid");
    expect(await latestSkillCommit("acme/skills", "skills/pdf-tools")).toBe(sha("b"));
  });

  it("a license is the repository's SPDX id or a LICENSE file in the skill's own folder", async () => {
    const r = repo();
    r.commits[sha("a")]!["skills/pdf-tools/LICENSE.txt"] = "Apache License 2.0 ...";
    setCatalogFetch(fakeCatalog({ "acme/skills": { ...r, license: "NOASSERTION" }, "acme/none": { ...repo(), license: null } }).fetchImpl);
    const withFile = await resolveSkill("acme/skills", "pdf-tools");
    expect(withFile.license).toBeNull();
    expect(withFile.licenseFile).toEqual({ path: "LICENSE.txt", content: "Apache License 2.0 ..." });
    expect(hasLicense(withFile)).toBe(true);
    // also when only inspecting (no files fetched): the license file is still read
    const inspected = await resolveSkill("acme/skills", "pdf-tools", { withFiles: false });
    expect(inspected.licenseFile?.path).toBe("LICENSE.txt");
    expect(inspected.files.find((f) => f.path === "scripts/run.py")!.content).toBeNull();
    const none = await resolveSkill("acme/none", "pdf-tools");
    expect(hasLicense(none)).toBe(false);
  });

  it("a root SKILL.md counts only when its name is the skill's", async () => {
    setCatalogFetch(fakeCatalog({ "solo/skill": { head: sha("c"), commits: { [sha("c")]: { "SKILL.md": SKILL_MD("solo", "d", "b"), "helper.sh": "echo" } } } }).fetchImpl);
    expect(await resolveSkill("solo/skill", "solo")).toMatchObject({ path: "SKILL.md", dir: "", files: [{ path: "helper.sh", size: 4, content: "echo" }] });
    expect(await codeOf(resolveSkill("solo/skill", "other"))).toBe("not_found");
  });

  it("finds a skill whose catalog id is its frontmatter name, not its folder", async () => {
    const files = { "skills/react-best-practices/SKILL.md": SKILL_MD("vercel-react-best-practices", "React", "b"), "skills/practices/SKILL.md": SKILL_MD("other", "x", "y") };
    setCatalogFetch(fakeCatalog({ "v/agent-skills": { head: sha("d"), commits: { [sha("d")]: files } } }).fetchImpl);
    expect((await resolveSkill("v/agent-skills", "vercel-react-best-practices")).path).toBe("skills/react-best-practices/SKILL.md");
  });

  it("a 403 is the rate limit only when GitHub says so; dot-only repository names are refused", async () => {
    const limited = (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as typeof fetch;
    setCatalogFetch(limited);
    expect(await codeOf(resolveSkill("acme/skills", "pdf-tools"))).toBe("rate_limited");
    setCatalogFetch((async () => new Response("{}", { status: 403 })) as typeof fetch);
    expect(await codeOf(resolveSkill("acme/skills", "pdf-tools"))).toBe("unavailable");
    expect(await codeOf(resolveSkill("acme/..", "pdf-tools"))).toBe("invalid");
    expect(await codeOf(resolveSkill("acme/repo.git", "pdf-tools"))).toBe("invalid");
  });

  it("parses frontmatter with quotes and without any", () => {
    expect(parseSkillMd(`---\nname: "x"\ndescription: 'Use it'\n---\nBody`)).toEqual({ name: "x", description: "Use it", body: "Body" });
    expect(parseSkillMd("Just text")).toEqual({ name: "", description: "", body: "Just text" });
  });
});
