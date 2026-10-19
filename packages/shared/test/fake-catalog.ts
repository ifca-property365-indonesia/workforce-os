/**
 * A fake skills.sh + GitHub for tests (setCatalogFetch): one repository per entry, its head commit and files can be
 * changed between calls. Synthetic data only.
 */
export interface FakeRepo {
  private?: boolean;
  license?: string | null;
  head: string;
  /** files per commit: path -> content */
  commits: Record<string, Record<string, string>>;
}

export const sha = (c: string) => c.repeat(40).slice(0, 40);

export function fakeCatalog(repos: Record<string, FakeRepo>, search: { source: string; skillId: string; name?: string; installs: number }[] = []) {
  const calls: string[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    if (url.host === "skills.sh") return json({ skills: search.map((s) => ({ id: `${s.source}/${s.skillId}`, name: s.name ?? s.skillId, ...s })) });
    if (url.host === "raw.githubusercontent.com") {
      const [, owner, repo, commit, ...rest] = url.pathname.split("/");
      const content = repos[`${owner}/${repo}`]?.commits[commit!]?.[rest.join("/")];
      return content === undefined ? new Response("404", { status: 404 }) : new Response(content);
    }
    if (url.host === "api.github.com") {
      const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
      const r = m ? repos[m[1]!] : undefined;
      if (!r) return json({ message: "Not Found" }, 404);
      const rest = m![2] ?? "";
      if (!rest) return json({ private: !!r.private, default_branch: "main", license: r.license === undefined ? { spdx_id: "MIT" } : r.license ? { spdx_id: r.license } : null });
      if (rest === "/commits/main") return json({ sha: r.head });
      // the newest commit that touched a folder: the head (tests change the head together with the folder)
      if (rest === "/commits") return json([{ sha: r.head }]);
      const tree = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/);
      if (tree) {
        const files = r.commits[tree[1]!];
        if (!files) return json({ message: "Not Found" }, 404);
        return json({ tree: Object.entries(files).map(([path, c]) => ({ path, type: "blob", size: Buffer.byteLength(c) })) });
      }
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const SKILL_MD = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
