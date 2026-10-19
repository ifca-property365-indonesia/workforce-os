import { createHash } from "node:crypto";

/**
 * C4: skills from the open catalog. skills.sh lists skills (their GitHub source and install counts); the content
 * itself is read from GitHub at one exact commit, never through a CLI on the host and never by running anything:
 * SKILL.md plus the text files next to it, the commit SHA, the license and a hash of SKILL.md. A person approves the
 * exact thing that was resolved; an update is a new commit, reviewed again. Node only (fetch).
 */

/** owner/repo; a repo named only of dots (".", "..") or ending in ".git" is refused (it would change the API path) */
export const SKILL_SOURCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.+$)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/;
export const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** text files kept next to SKILL.md (scripts, references, templates); anything else is listed but not fetched */
const TEXT_EXT = /\.(md|mdx|txt|py|js|mjs|cjs|ts|sh|bash|json|ya?ml|toml|csv|html|css|xml|sql|ini|cfg)$/i;
export const SKILL_FILE_MAX = 200 * 1024;
export const SKILL_FILES_TOTAL_MAX = 1024 * 1024;
export const SKILL_FILES_COUNT_MAX = 60;
const SKILL_MD_MAX = 64 * 1024;
const TIMEOUT_MS = 15_000;

export interface CatalogEntry {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

export interface ResolvedSkill {
  source: string;
  skillId: string;
  /** SKILL.md's path in the repository */
  path: string;
  /** the skill's directory in the repository ("" at the root) */
  dir: string;
  commit: string;
  /** SPDX id of the repository's license, null when GitHub finds none (or NOASSERTION) */
  license: string | null;
  /** a license file inside the skill's own directory (shown to the approver) */
  licenseFile: { path: string; content: string } | null;
  url: string;
  name: string;
  description: string;
  /** SKILL.md without its frontmatter */
  body: string;
  /** sha256 of SKILL.md exactly as fetched */
  contentHash: string;
  /** files next to SKILL.md: text ones with their content (within the limits), others listed only */
  files: { path: string; size: number; content: string | null }[];
}

export class SkillCatalogError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not_found" | "private" | "too_large" | "unavailable" | "rate_limited",
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** tests replace the network */
export function setCatalogFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "workforce-os" };
  const token = process.env.WFOS_GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** 429, or a 403 that says the quota is used up (x-ratelimit-remaining: 0, or retry-after) */
const isRateLimited = (r: Response) => r.status === 429 || (r.status === 403 && (r.headers.get("x-ratelimit-remaining") === "0" || r.headers.has("retry-after")));

/** a raw.githubusercontent.com URL of one file at one commit, each path segment encoded */
const rawUrl = (source: string, commit: string, path: string) => `https://raw.githubusercontent.com/${source}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

async function getJson<T>(url: string, headers: Record<string, string> = ghHeaders()): Promise<T> {
  const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (r.status === 404) throw new SkillCatalogError("Not found", "not_found");
  if (isRateLimited(r)) throw new SkillCatalogError("GitHub rate limit reached: try again later (or set WFOS_GITHUB_TOKEN)", "rate_limited");
  // a 403 that is not the rate limit: a blocked or unavailable repository
  if (!r.ok) throw new SkillCatalogError(`GitHub answered ${r.status}`, "unavailable");
  return (await r.json()) as T;
}

async function getText(url: string, max: number): Promise<string> {
  const r = await fetchImpl(url, { headers: { "user-agent": "workforce-os" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (r.status === 404) throw new SkillCatalogError("Not found", "not_found");
  if (isRateLimited(r)) throw new SkillCatalogError("GitHub rate limit reached: try again later", "rate_limited");
  if (!r.ok) throw new SkillCatalogError(`GitHub answered ${r.status}`, "unavailable");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw new SkillCatalogError(`File larger than ${Math.round(max / 1024)} KB`, "too_large");
  return buf.toString("utf8");
}

/** skills.sh search (its JSON endpoint), most installed first. */
export async function searchSkillsSh(query: string, limit = 10): Promise<CatalogEntry[]> {
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  const url = `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${Math.min(25, Math.max(1, limit))}`;
  const data = await getJson<{ skills?: { source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown }[] }>(url, { "user-agent": "workforce-os", accept: "application/json" });
  return (data.skills ?? [])
    .filter((s) => typeof s.source === "string" && SKILL_SOURCE_RE.test(s.source) && typeof s.skillId === "string" && SKILL_ID_RE.test(s.skillId))
    .map((s) => ({ source: s.source as string, skillId: s.skillId as string, name: typeof s.name === "string" ? s.name.slice(0, 100) : (s.skillId as string), installs: Number(s.installs) || 0 }))
    .sort((a, b) => b.installs - a.installs)
    .slice(0, limit);
}

/** --- name: … / description: … --- frontmatter (single-line values, quotes optional) and the rest. */
export function parseSkillMd(md: string): { name: string; description: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const front = m?.[1] ?? "";
  const field = (k: string) => {
    const v = front.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
    return v.replace(/^(["'])(.*)\1$/, "$2");
  };
  return { name: field("name"), description: field("description"), body: (m ? md.slice(m[0].length) : md).trim() };
}

export function skillHash(md: string): string {
  return createHash("sha256").update(md).digest("hex");
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

/**
 * The skill `skillId` of `source` (owner/repo) at `commit` (default: the head of the default branch): the SKILL.md
 * whose directory is named like the skill (skills/<id>/SKILL.md preferred), or a root SKILL.md whose name matches.
 */
export async function resolveSkill(source: string, skillId: string, opts: { commit?: string; withFiles?: boolean } = {}): Promise<ResolvedSkill> {
  if (!SKILL_SOURCE_RE.test(source)) throw new SkillCatalogError("The source must be a GitHub owner/repo", "invalid");
  if (!SKILL_ID_RE.test(skillId)) throw new SkillCatalogError("Invalid skill name", "invalid");
  if (opts.commit && !SHA_RE.test(opts.commit)) throw new SkillCatalogError("Invalid commit", "invalid");
  const api = `https://api.github.com/repos/${source}`;
  const repo = await getJson<{ private?: boolean; default_branch?: string; license?: { spdx_id?: string } | null }>(api);
  if (repo.private) throw new SkillCatalogError("Private repositories are not used", "private");
  const commit = opts.commit ?? (await getJson<{ sha?: string }>(`${api}/commits/${encodeURIComponent(repo.default_branch ?? "main")}`)).sha ?? "";
  if (!SHA_RE.test(commit)) throw new SkillCatalogError("Could not find the repository's latest commit", "unavailable");
  const tree = await getJson<{ tree?: TreeEntry[]; truncated?: boolean }>(`${api}/git/trees/${commit}?recursive=1`);
  const entries = tree.tree ?? [];
  const want = skillId.toLowerCase();
  const candidates = entries.filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/i.test(e.path));
  const dirName = (p: string) => p.split("/").slice(-2, -1)[0]?.toLowerCase() ?? "";
  const byDir = candidates
    .filter((e) => dirName(e.path) === want)
    .sort((a, b) => Number(!a.path.startsWith("skills/")) - Number(!b.path.startsWith("skills/")) || a.path.length - b.path.length);
  let skillMd = byDir[0];
  if (!skillMd) {
    // the catalog's id is the frontmatter name, which may differ from the folder (vercel-react-best-practices in
    // react-best-practices/): a root SKILL.md, then folders whose name the id ends with, read and matched by name
    const near = candidates
      .filter((e) => !e.path.includes("/") || (dirName(e.path).length >= 3 && want.endsWith(dirName(e.path))))
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, 5);
    for (const e of near) {
      const md = await getText(rawUrl(source, commit, e.path), SKILL_MD_MAX);
      if (parseSkillMd(md).name.toLowerCase() === want) {
        skillMd = e;
        break;
      }
    }
  }
  // GitHub lists at most ~100k entries: in a larger repository the skill may be past the cut
  if (!skillMd && tree.truncated) throw new SkillCatalogError(`${source} is too large to search for "${skillId}"`, "too_large");
  if (!skillMd) throw new SkillCatalogError(`No skill "${skillId}" in ${source}`, "not_found");
  const md = await getText(rawUrl(source, commit, skillMd.path), SKILL_MD_MAX);
  const parsed = parseSkillMd(md);
  const dir = skillMd.path.includes("/") ? skillMd.path.slice(0, skillMd.path.lastIndexOf("/")) : "";
  const prefix = dir ? `${dir}/` : "";
  const siblings = entries.filter((e) => e.type === "blob" && e.path !== skillMd.path && (dir ? e.path.startsWith(prefix) : !e.path.includes("/")));
  const files: ResolvedSkill["files"] = [];
  let total = 0;
  let fetched = 0;
  let licenseFile: ResolvedSkill["licenseFile"] = null;
  for (const e of siblings.slice(0, 200)) {
    const rel = e.path.slice(prefix.length);
    const size = e.size ?? 0;
    const base = rel.split("/").pop() ?? "";
    const isText = TEXT_EXT.test(rel) || /^LICEN[CS]E/i.test(base);
    let content: string | null = null;
    // the skill's own license file is always read (inspecting without files must still see the license)
    const isLicense = /^LICEN[CS]E(\.(md|txt))?$/i.test(rel);
    if ((opts.withFiles !== false || isLicense) && isText && size <= SKILL_FILE_MAX && total + size <= SKILL_FILES_TOTAL_MAX && fetched < SKILL_FILES_COUNT_MAX) {
      content = await getText(rawUrl(source, commit, e.path), SKILL_FILE_MAX);
      total += size;
      fetched += 1;
    }
    if (isLicense && content !== null) licenseFile = { path: rel, content: content.slice(0, 20_000) };
    files.push({ path: rel, size, content });
  }
  const spdx = repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : null;
  return {
    source,
    skillId,
    path: skillMd.path,
    dir,
    commit,
    license: spdx,
    licenseFile,
    url: `https://github.com/${source}/tree/${commit}/${dir}`,
    name: parsed.name || skillId,
    description: parsed.description.slice(0, 1024),
    body: parsed.body,
    contentHash: skillHash(md),
    files,
  };
}

/** The newest commit that touched the skill's directory (for update checks). */
export async function latestSkillCommit(source: string, dir: string): Promise<string | null> {
  if (!SKILL_SOURCE_RE.test(source)) return null;
  const rows = await getJson<{ sha?: string }[]>(`https://api.github.com/repos/${source}/commits?per_page=1${dir ? `&path=${encodeURIComponent(dir)}` : ""}`);
  const sha = rows[0]?.sha ?? null;
  return sha && SHA_RE.test(sha) ? sha : null;
}

/** A license the platform accepts: an SPDX license on the repository, or a license file in the skill's own folder. */
export const hasLicense = (s: Pick<ResolvedSkill, "license" | "licenseFile">) => !!s.license || !!s.licenseFile;
