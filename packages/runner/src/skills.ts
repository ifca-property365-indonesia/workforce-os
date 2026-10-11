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
 * Pure Node (no dependency), so the worker's tests can exercise it against a temp directory.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SkillFileSpec {
  slug: string;
  description: string;
  body: string;
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
    // the directory holds exactly SKILL.md and the marker: anything the agent added there is dropped
    for (const entry of await readdir(dir)) {
      if (entry !== "SKILL.md" && entry !== MANAGED_SKILL_MARKER) await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    await replaceFile(dir, "SKILL.md", skillFileMarkdown(s));
    res.written.push(s.slug);
  }
  return res;
}
