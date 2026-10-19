/**
 * The employee's trusted skills as Claude Code skill files, materialised by the runner (as the sandbox user) on
 * EVERY run, in the run's own home: `~/.claude/skills/wfos-<slug>/SKILL.md`.
 *
 * - Only directories named `wfos-<slug>` that carry the `.wfos-managed` marker belong to the platform: they are
 *   rewritten from the run spec, and removed when the skill is no longer in it (unassigned, disabled, or untrusted).
 * - Anything else (built-in skills such as pdf/docx, or a directory the agent made) is never touched.
 * - The agent may have left symlinks in its home in an earlier run: nothing here follows one (lstat everywhere,
 *   a symlink is refused, and files are replaced by rename, which replaces a link, never its target).
 *
 * Untrusted skills are never in the spec: they are reachable only through skill_read, which taints the run.
 * Built-in skills (syncBuiltinSkills, below) are copied from the runner's own read-only skills folder.
 * Pure Node (no dependency), so the worker's tests can exercise it against a temp directory.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SkillFileSpec {
  slug: string;
  description: string;
  body: string;
  /** C4: text files next to SKILL.md (a catalog skill's scripts and references), relative paths */
  files?: { path: string; content: string }[];
}

/** a relative path inside a skill folder: no absolute path, no "..", no hidden or marker file, at most 4 levels */
export function safeSkillFilePath(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 200 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  const parts = p.split("/");
  return parts.length <= 4 && parts.every((x) => x && x !== "." && x !== ".." && !x.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(x)) && p !== "SKILL.md";
}

export const MANAGED_SKILL_PREFIX = "wfos-";
export const MANAGED_SKILL_MARKER = ".wfos-managed";
/** Same rule as SKILL_SLUG_RE in @wfos/shared (re-checked here: the runner trusts no path from outside). */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Claude Code limits a skill name (= its directory name) to 64 characters. */
const NAME_MAX = 64;

export const managedSkillDir = (slug: string) => `${MANAGED_SKILL_PREFIX}${slug}`;

/** A slug the runner will write: kebab-case, and `wfos-<slug>` within the skill name cap. */
export function writableSkillSlug(slug: string): boolean {
  return typeof slug === "string" && SLUG_RE.test(slug) && managedSkillDir(slug).length <= NAME_MAX;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * SKILL.md as Claude Code reads it: the `---` frontmatter on line 1 (name = the directory name, description on one
 * line), then a platform comment, then the body. JSON strings are valid YAML double-quoted scalars, so no newline
 * or quote in the description can break the frontmatter.
 */
export function skillFileMarkdown(s: SkillFileSpec): string {
  const front = ["---", `name: ${JSON.stringify(managedSkillDir(s.slug))}`, `description: ${JSON.stringify(oneLine(s.description))}`, "---"].join("\n");
  return `${front}\n<!-- managed by Workforce OS: rewritten on every run; edit the skill in the app -->\n\n${s.body.trimEnd()}\n`;
}

type Kind = "missing" | "dir" | "file" | "symlink" | "other";
async function kindOf(p: string): Promise<Kind> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
}

/** Write a file by rename from a fresh temp file in the same directory (never through an existing symlink). */
async function replaceFile(dir: string, name: string, content: string): Promise<void> {
  const tmp = path.join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    await rename(tmp, path.join(dir, name));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** A real directory named wfos-* holding the marker as a regular file: one the platform wrote. */
async function isManagedDir(dir: string): Promise<boolean> {
  return (await kindOf(dir)) === "dir" && (await kindOf(path.join(dir, MANAGED_SKILL_MARKER))) === "file";
}

export interface SkillSyncResult {
  written: string[];
  removed: string[];
  /** slugs (or directory names) refused: invalid slug, symlink, or a directory the platform did not create */
  skipped: string[];
}

/**
 * Bring `<skillsRoot>` (the run's ~/.claude/skills) in line with `list`: write each skill to `wfos-<slug>/SKILL.md`
 * (plus the marker; any other entry the agent left inside a managed directory is removed), and delete managed
 * `wfos-*` directories whose skill is not in the list. Refuses to work through a symlinked skills root.
 */
export async function syncSkillFiles(root: string, list: SkillFileSpec[]): Promise<SkillSyncResult> {
  const skillsRoot = path.resolve(root);
  const res: SkillSyncResult = { written: [], removed: [], skipped: [] };
  for (const p of [path.dirname(skillsRoot), skillsRoot]) {
    const k = await kindOf(p);
    if (k === "missing") await mkdir(p, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
    else if (k !== "dir") throw new Error(`skills directory refused: ${p} is a ${k}`);
  }
  if ((await kindOf(skillsRoot)) !== "dir") throw new Error(`skills directory refused: ${skillsRoot}`);

  const wanted = new Map<string, SkillFileSpec>();
  for (const s of list) {
    if (!writableSkillSlug(s.slug)) res.skipped.push(String(s.slug).slice(0, NAME_MAX));
    else if (!wanted.has(s.slug)) wanted.set(s.slug, s);
  }

  // stale managed directories first (a skill unassigned, disabled or now untrusted must not stay loadable)
  for (const name of await readdir(skillsRoot)) {
    if (!name.startsWith(MANAGED_SKILL_PREFIX)) continue; // built-ins and anything else: never touched
    const slug = name.slice(MANAGED_SKILL_PREFIX.length);
    if (wanted.has(slug)) continue;
    const dir = path.join(skillsRoot, name);
    if (!(await isManagedDir(dir))) continue; // not ours (or a symlink): left alone
    await rm(dir, { recursive: true, force: true }); // rm never follows symlinks inside the tree
    res.removed.push(slug);
  }

  for (const s of wanted.values()) {
    const dir = path.join(skillsRoot, managedSkillDir(s.slug));
    if (path.dirname(dir) !== skillsRoot) {
      res.skipped.push(s.slug);
      continue;
    }
    const k = await kindOf(dir);
    if (k === "missing") {
      await mkdir(dir, { mode: 0o700 });
      await writeFile(path.join(dir, MANAGED_SKILL_MARKER), "Managed by Workforce OS. Rewritten or removed on every run.\n", { mode: 0o600, flag: "wx" });
    } else if (k !== "dir" || !(await isManagedDir(dir))) {
      res.skipped.push(s.slug); // a symlink, a file, or a directory the platform did not create
      continue;
    }
    // the directory holds exactly SKILL.md, the marker and the skill's own files: anything the agent added is dropped
    for (const entry of await readdir(dir)) {
      if (entry !== "SKILL.md" && entry !== MANAGED_SKILL_MARKER) await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    await replaceFile(dir, "SKILL.md", skillFileMarkdown(s));
    for (const f of s.files ?? []) {
      if (!safeSkillFilePath(f.path)) continue;
      const target = path.join(dir, f.path);
      if (!target.startsWith(`${dir}${path.sep}`)) continue;
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, f.content, { mode: /\.(sh|bash|py)$/.test(f.path) ? 0o700 : 0o600 });
    }
    res.written.push(s.slug);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Built-in skills (docx, pdf, pptx, xlsx, app-nextjs): shipped with the runner under dist/skills
// ---------------------------------------------------------------------------

/** Marks a built-in skill directory the platform wrote; holds the version (content hash) it was copied at. */
export const BUILTIN_SKILL_MARKER = ".wfos-builtin";
const BUILTIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** temp directories syncBuiltinSkills makes in the skills root (left behind when a run died mid-copy) */
const BUILTIN_TMP_RE = /^\.[a-z0-9][a-z0-9-]{0,63}\.[0-9a-f]{12}\.tmp$/;
/**
 * Versions (builtinSkillVersion) each built-in had before the marker existed, newest last. An unmarked copy equal to
 * one of them was seeded by the platform and is upgraded; an unmarked copy matching none was edited and is left
 * alone. When a built-in changes, add its previous version here (homes seeded before this change carry no marker).
 */
export const PREVIOUS_BUILTIN_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  // before the fonts rule (2026-10-15)
  "app-nextjs": ["c8cbdeffd0b644142c292edd55dabecf4e3101c03c5265b08f2ae257503f2685"],
};
/** a directory without the marker is compared with the built-in only up to this size (then it is not ours) */
const ADOPT_MAX_BYTES = 8 * 1024 * 1024;

/** Regular files under `dir` (relative paths, sorted), symlinks and the marker left out; null past `maxBytes`. */
async function treeFiles(dir: string, maxBytes = Infinity): Promise<{ rel: string; data: Buffer }[] | null> {
  const out: { rel: string; data: Buffer }[] = [];
  let bytes = 0;
  const walk = async (d: string, prefix: string): Promise<boolean> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!(await walk(path.join(d, e.name), rel))) return false;
      } else if (e.isFile() && rel !== BUILTIN_SKILL_MARKER) {
        // the size first: a huge file the agent left in a copy is never read into memory
        bytes += (await lstat(path.join(d, e.name))).size;
        if (bytes > maxBytes) return false;
        const data = await readFile(path.join(d, e.name));
        out.push({ rel, data });
      }
    }
    return true;
  };
  return (await walk(dir, "")) ? out : null;
}

function treeHash(files: { rel: string; data: Buffer }[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}\0${f.data.length}\0`).update(f.data);
  return h.digest("hex");
}

/** The version of a built-in skill directory: a hash of its files (any change to them is a new version). */
export async function builtinSkillVersion(dir: string): Promise<string> {
  return treeHash((await treeFiles(dir))!);
}

/** Copy `files` into a fresh directory (created here, so nothing in it can be a planted link). */
async function writeTree(dir: string, files: { rel: string; data: Buffer }[]): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  for (const f of files) {
    const target = path.join(dir, f.rel);
    if (!target.startsWith(`${dir}${path.sep}`)) throw new Error(`bad path in a built-in skill: ${f.rel}`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, f.data, { mode: 0o600, flag: "wx" });
  }
}

export interface BuiltinSyncResult {
  /** copied for the first time */
  installed: string[];
  /** replaced: the built-in changed since it was copied */
  updated: string[];
  /** an unmarked copy identical to the built-in (seeded before the marker existed): marked, not rewritten */
  adopted: string[];
  /** left alone: a symlink, a file, or a directory that differs from the built-in and carries no marker */
  skipped: string[];
}

/**
 * Bring the built-in skills in `<skillsRoot>` up to date with `srcRoot` (the runner's read-only dist/skills): a
 * missing one is copied, one the platform copied (marker) whose version changed is replaced, an identical unmarked
 * one is marked. Nothing else in the skills directory is touched (the employee's wfos-* skills, the agent's own
 * directories, an edited copy without a marker). Runs as the sandbox user on every run, so an EXISTING workspace
 * home also gets new built-ins; never follows a symlink (lstat, fresh temp directories, rename into place).
 */
export async function syncBuiltinSkills(srcRoot: string, root: string, previous: Readonly<Record<string, readonly string[]>> = PREVIOUS_BUILTIN_VERSIONS): Promise<BuiltinSyncResult> {
  const res: BuiltinSyncResult = { installed: [], updated: [], adopted: [], skipped: [] };
  if ((await kindOf(srcRoot)) !== "dir") return res;
  const skillsRoot = path.resolve(root);
  for (const p of [path.dirname(skillsRoot), skillsRoot]) {
    const k = await kindOf(p);
    if (k === "missing") await mkdir(p, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
    else if (k !== "dir") throw new Error(`skills directory refused: ${p} is a ${k}`);
  }
  if ((await kindOf(skillsRoot)) !== "dir") throw new Error(`skills directory refused: ${skillsRoot}`);
  // temp copies a run that died mid-copy left behind (only real directories with our temp name)
  for (const name of await readdir(skillsRoot)) {
    if (BUILTIN_TMP_RE.test(name) && (await kindOf(path.join(skillsRoot, name))) === "dir") await rm(path.join(skillsRoot, name), { recursive: true, force: true });
  }

  for (const e of (await readdir(srcRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || !BUILTIN_NAME_RE.test(e.name) || e.name.startsWith(MANAGED_SKILL_PREFIX)) continue;
    const files = (await treeFiles(path.join(srcRoot, e.name)))!;
    const version = treeHash(files);
    const target = path.join(skillsRoot, e.name);
    const k = await kindOf(target);
    let replace = false;
    if (k === "dir") {
      const marker = path.join(target, BUILTIN_SKILL_MARKER);
      if ((await kindOf(marker)) === "file") {
        if ((await readFile(marker, "utf8")).trim() === version) continue; // current
        replace = true;
      } else {
        const theirs = await treeFiles(target, ADOPT_MAX_BYTES);
        const hash = theirs ? treeHash(theirs) : null;
        if (hash === version) {
          await replaceFile(target, BUILTIN_SKILL_MARKER, `${version}\n`);
          res.adopted.push(e.name);
          continue;
        }
        // an older shipped version seeded without a marker: the platform's, so upgraded; anything else was edited
        if (!hash || !(previous[e.name] ?? []).includes(hash)) {
          res.skipped.push(e.name);
          continue;
        }
        replace = true;
      }
    } else if (k !== "missing") {
      res.skipped.push(e.name);
      continue;
    }
    const tmp = path.join(skillsRoot, `.${e.name}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeTree(tmp, files);
      await writeFile(path.join(tmp, BUILTIN_SKILL_MARKER), `${version}\n`, { mode: 0o600, flag: "wx" });
      if (replace) await rm(target, { recursive: true, force: true }); // rm never follows symlinks inside the tree
      await rename(tmp, target);
      (replace ? res.updated : res.installed).push(e.name);
    } catch {
      await rm(tmp, { recursive: true, force: true });
      res.skipped.push(e.name);
    }
  }
  return res;
}
