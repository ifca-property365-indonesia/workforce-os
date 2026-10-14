import { z } from "zod";
import { APP_MANIFEST_FILE, appManifestSchema, type AppManifest, type ReleaseWarning } from "@wfos/shared";
import { rootGit } from "../runner/workspace/git";

const MAX_MANIFEST_BYTES = 16 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
/** added lines in a migration that can lose data */
export const DESTRUCTIVE_SQL_RE = /DROP TABLE|DROP COLUMN|TRUNCATE|ALTER TABLE .* DROP|DELETE FROM/i;
/**
 * where Prisma, Drizzle, Rails/Knex-style and plain SQL migrations live (at any depth of the repository), plus SQL files
 * named like a migration or a schema, and the Prisma schema
 */
const MIGRATION_PATHSPECS = [
  ":(glob)**/prisma/migrations/**",
  ":(glob)**/drizzle/**",
  ":(glob)**/migrations/**",
  ":(glob)**/db/migrate/**",
  ":(glob)**/sql/**",
  // any file named like a migration (scripts/migrate.mjs too): not plain SQL there means the expand check cannot judge it
  ":(glob,icase)**/*migrat*",
  ":(glob,icase)**/*schema*.sql",
  ":(glob)**/prisma/schema.prisma",
];

/** A deploy refused for a reason the person can fix (bad manifest, missing commit…); the message is shown as is. */
export class DeployInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployInputError";
  }
}

/** The commit `branch` points at in the mirror. */
export async function resolveBranch(mirror: string, branch: string): Promise<string> {
  const sha = (await rootGit(["-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).catch(() => "")).trim();
  if (!SHA_RE.test(sha)) throw new DeployInputError(`Branch ${branch} was not found in the repository`);
  return sha;
}

export async function assertCommit(mirror: string, sha: string): Promise<void> {
  const ok = SHA_RE.test(sha) && (await rootGit(["-C", mirror, "cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false));
  if (!ok) throw new DeployInputError(`Commit ${sha.slice(0, 12)} is not in the repository`);
}

export async function commitSubject(mirror: string, sha: string): Promise<string> {
  return (await rootGit(["-C", mirror, "log", "-1", "--format=%s", sha])).trim().slice(0, 300);
}

/** A file at a commit, or null when it is not there; refuses files over `maxBytes`. */
async function fileAt(mirror: string, sha: string, file: string, maxBytes: number): Promise<string | null> {
  const size = Number((await rootGit(["-C", mirror, "cat-file", "-s", `${sha}:${file}`]).catch(() => "")).trim());
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size > maxBytes) throw new DeployInputError(`${file} is larger than ${Math.round(maxBytes / 1024)} KB`);
  return rootGit(["-C", mirror, "cat-file", "blob", `${sha}:${file}`], { maxBuffer: maxBytes + 1024 });
}

/** The validated wfos-app.json of a commit (missing / invalid → DeployInputError with what is wrong). */
export async function readManifest(mirror: string, sha: string): Promise<AppManifest> {
  const raw = await fileAt(mirror, sha, APP_MANIFEST_FILE, MAX_MANIFEST_BYTES);
  if (raw === null) throw new DeployInputError(`${APP_MANIFEST_FILE} is missing at the root of the repository (commit ${sha.slice(0, 12)})`);
  return parseManifest(raw);
}

export function parseManifest(raw: string | unknown): AppManifest {
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new DeployInputError(`${APP_MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const parsed = appManifestSchema.safeParse(json);
  if (!parsed.success) throw new DeployInputError(`${APP_MANIFEST_FILE} is invalid: ${z.prettifyError(parsed.error).replace(/\n+/g, "; ")}`);
  return parsed.data;
}

/** package.json `scripts` at a commit (null without a package.json or with one that does not parse). */
async function scriptsAt(mirror: string, sha: string): Promise<string | null> {
  const raw = await fileAt(mirror, sha, "package.json", 1024 * 1024).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.stringify((JSON.parse(raw) as { scripts?: unknown }).scripts ?? null);
  } catch {
    return null;
  }
}

/** One line added to a migration file between two commits. */
export interface AddedMigrationLine {
  file: string;
  line: string;
}

/** One migration file changed between two commits: A(dded), M(odified) or D(eleted) (renames are a D and an A). */
export interface MigrationFileChange {
  file: string;
  status: "A" | "M" | "D";
  added: string[];
  removed: string[];
  binary: boolean;
}

/** The migration files changed between two commits, with their added and removed lines. */
export async function migrationChanges(mirror: string, from: string, to: string): Promise<MigrationFileChange[]> {
  const diff = await rootGit(
    // explicit prefixes: a diff.noprefix / diff.mnemonicPrefix setting must not change the header lines read below
    ["-C", mirror, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U0", from, to, "--", ...MIGRATION_PATHSPECS],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const out: MigrationFileChange[] = [];
  let cur: MigrationFileChange | null = null;
  const unq = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/.exec(l);
      cur = { file: m?.[2] ?? m?.[1] ?? l.slice(11), status: "M", added: [], removed: [], binary: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("new file mode")) cur.status = "A";
    else if (l.startsWith("deleted file mode")) cur.status = "D";
    else if (l.startsWith("Binary files ")) cur.binary = true;
    else if (l.startsWith("+++ ")) {
      const name = unq(l.slice(4).trim());
      if (name !== "/dev/null") cur.file = name.replace(/^b\//, "");
    } else if (l.startsWith("--- ")) {
      const name = unq(l.slice(4).trim());
      if (name !== "/dev/null" && cur.status === "D") cur.file = name.replace(/^a\//, "");
    } else if (l.startsWith("+")) cur.added.push(l.slice(1));
    else if (l.startsWith("-")) cur.removed.push(l.slice(1));
  }
  return out;
}

/** Lines added to migration files between two commits (with the file each is in). */
export async function addedMigrationLines(mirror: string, from: string, to: string): Promise<AddedMigrationLine[]> {
  return (await migrationChanges(mirror, from, to)).flatMap((f) => f.added.map((line) => ({ file: f.file, line })));
}

/** Lines added to migration files between two commits that match DESTRUCTIVE_SQL_RE. */
export async function destructiveMigrationLines(mirror: string, from: string, to: string): Promise<string[]> {
  return (await addedMigrationLines(mirror, from, to)).map((l) => l.line).filter((l) => DESTRUCTIVE_SQL_RE.test(l));
}

/**
 * What a migration may not do when wfos-app.json says `"migrations": "expand"` (it then runs while the old version
 * keeps serving, and a failed release never restores the database): anything that drops, renames, narrows or deletes.
 * Each rule is tested on one clause of a statement (comments, string literals and quoted names blanked first).
 */
const EXPAND_UNSAFE: { what: string; test: (clause: string) => boolean }[] = [
  { what: "ADD CONSTRAINT", test: (c) => /\bADD\s+CONSTRAINT\b/i.test(c) },
  { what: "CREATE UNIQUE INDEX", test: (c) => /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(c) },
  { what: "UPDATE … SET", test: (c) => /(?<!\bON\s+)\bUPDATE\b[\s\S]*\bSET\b/i.test(c) },
  { what: "CREATE OR REPLACE", test: (c) => /\bCREATE\s+OR\s+REPLACE\s+(?:FUNCTION|VIEW|TRIGGER|PROCEDURE|RULE)\b/i.test(c) },
  { what: "ALTER … DISABLE / ENABLE", test: (c) => /\bALTER\b[\s\S]*\b(?:DISABLE|ENABLE)\b/i.test(c) },
  { what: "ALTER … TYPE", test: (c) => /\bALTER\s+TYPE\b/i.test(c) || /\bALTER\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(c) },
  { what: "SET NOT NULL", test: (c) => /\bSET\s+NOT\s+NULL\b/i.test(c) },
  { what: "DELETE", test: (c) => /\bDELETE\s+FROM\b/i.test(c) || /^\s*DELETE\b/i.test(c) },
  { what: "TRUNCATE", test: (c) => /\bTRUNCATE\b/i.test(c) },
  { what: "ADD … NOT NULL without DEFAULT", test: (c) => /\bADD\b[\s\S]*\bNOT\s+NULL\b/i.test(c) && !/\bDEFAULT\b/i.test(c) },
];

/** DROP and RENAME are looked for anywhere (also inside strings and function bodies: EXECUTE 'DROP …'). */
const ANYWHERE_UNSAFE: { what: string; re: RegExp }[] = [
  { what: "DROP", re: /\bDROP\b/i },
  { what: "RENAME", re: /\bRENAME\b/i },
];

/** Comments become spaces, string literals and quoted names keep their length but lose their words. */
function blankSql(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => {
    if (m.startsWith("'")) return `'${"x".repeat(m.length - 2)}'`;
    if (m.startsWith('"')) return "q".repeat(m.length);
    return m.replace(/[^\n]/g, " ");
  });
}

export interface ExpandViolation {
  file: string;
  /** which rule (DROP, RENAME, …) */
  what: string;
  /** the statement as written (whitespace collapsed, cut at 160 characters) */
  statement: string;
}

/** The statements of added migration lines (per file) that an expand migration may not contain. */
export function expandViolationsIn(lines: AddedMigrationLine[]): ExpandViolation[] {
  const byFile = new Map<string, string[]>();
  for (const l of lines) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l.line]);
  const out: ExpandViolation[] = [];
  for (const [file, ls] of byFile) {
    const text = ls.join("\n");
    const blank = blankSql(text);
    // the same length, comments blanked but strings and quoted names as written
    const noComments = text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") || m.startsWith('"') ? m : m.replace(/[^\n]/g, " ")));
    let start = 0;
    for (let i = 0; i <= blank.length; i++) {
      if (i < blank.length && blank[i] !== ";") continue;
      const stmt = blank.slice(start, i);
      // comments only blanked: strings and quoted names kept
      const raw = noComments.slice(start, i);
      // clauses of one ALTER TABLE (… ADD x, ADD y DEFAULT 0, DROP z) are judged one by one
      const hit =
        ANYWHERE_UNSAFE.find((r) => r.re.test(raw)) ??
        stmt
          .split(/,\s*(?=(?:ADD|ALTER|DROP|RENAME)\b)/i)
          .map((clause) => EXPAND_UNSAFE.find((r) => r.test(clause)))
          .find(Boolean);
      if (hit) {
        const statement = text.slice(start, i).replace(/\s+/g, " ").trim();
        out.push({ file, what: hit.what, statement: statement.length > 160 ? `${statement.slice(0, 157)}…` : statement });
      }
      start = i + 1;
    }
  }
  return out;
}

/** bookkeeping next to migrations that never runs as SQL (drizzle-kit snapshots and journal, Prisma's lock file) */
const MIGRATION_BOOKKEEPING_RE = /(?:^|\/)(?:meta\/[^/]+\.json|migration_lock\.toml)$/;
const isSql = (f: string) => /\.sql$/i.test(f);
const isPrismaSchema = (f: string) => /(?:^|\/)prisma\/schema\.prisma$/.test(f);
/** a line that says nothing (blank, or a comment) */
const meaningless = (l: string) => !l.trim() || /^\s*(?:--|\/\/)/.test(l);

/**
 * What a set of changed migration files does that an expand migration may not: SQL statements (expandViolationsIn),
 * and what cannot be judged at all — a migration file that is not plain SQL (JS/TS migrations, binaries), a deleted
 * SQL migration, a Prisma schema change that removes or changes a line. Best effort: a lint, not a proof.
 */
export function expandViolationsOf(changes: MigrationFileChange[]): ExpandViolation[] {
  const out: ExpandViolation[] = [];
  const sqlLines: AddedMigrationLine[] = [];
  for (const f of changes) {
    if (MIGRATION_BOOKKEEPING_RE.test(f.file)) continue;
    if (isPrismaSchema(f.file)) {
      const removed = f.removed.filter((l) => !meaningless(l));
      if (f.status === "D" || removed.length) out.push({ file: f.file, what: "a schema change that removes or changes a line", statement: (removed[0] ?? "(deleted)").trim().slice(0, 160) });
      continue;
    }
    if (!isSql(f.file) || f.binary) {
      out.push({ file: f.file, what: "a migration that is not plain SQL (its effect cannot be checked)", statement: f.status === "D" ? "(deleted)" : "(not SQL)" });
      continue;
    }
    if (f.status === "D") {
      out.push({ file: f.file, what: "a deleted migration", statement: "(deleted)" });
      continue;
    }
    for (const line of f.added) sqlLines.push({ file: f.file, line });
  }
  return [...out, ...expandViolationsIn(sqlLines)];
}

/** What the migration files changed between the running release and this one do that an expand migration may not. */
export async function expandViolations(mirror: string, from: string, to: string): Promise<ExpandViolation[]> {
  return expandViolationsOf(await migrationChanges(mirror, from, to));
}

/** The refusal of a release that claims "expand" but whose migration does not only add (names the file and statement). */
export function expandRefusalMessage(v: ExpandViolation[]): string {
  const first = v[0]!;
  const more = v.length > 1 ? ` (and ${v.length - 1} more)` : "";
  return (
    `wfos-app.json claims "migrations": "expand" but ${first.file} contains ${first.what}: ${first.statement}${more}. ` +
    `An expand migration only adds (tables, nullable columns or columns with a default, indexes) and runs while the old version keeps serving; ` +
    `split the change (add now, remove in a later release), keep it to plain SQL that only adds, or set "migrations": "breaking" (LIVE then shows a maintenance page while it migrates). ` +
    `(The expand check is a best-effort lint of the migration files, not a proof.) Nothing was changed.`
  );
}

/** Stable form of a manifest for comparing two of them. */
function canonical(m: AppManifest): string {
  return JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * What the release page / approval card warns about, computed against the release that runs now (`current`: its
 * commit and manifest; null when nothing was deployed yet).
 */
export async function releaseWarnings(o: {
  mirror: string;
  sha: string;
  manifest: AppManifest;
  current: { commit: string; manifest: AppManifest | null } | null;
  hasDatabase: boolean;
  accessMode: "password" | "public";
}): Promise<ReleaseWarning[]> {
  const w: ReleaseWarning[] = [];
  const cur = o.current;
  if (!cur) w.push("first_publish");
  else {
    if (!cur.manifest || canonical(cur.manifest) !== canonical(o.manifest)) w.push("manifest_changed");
    if (cur.commit !== o.sha && (await scriptsAt(o.mirror, cur.commit)) !== (await scriptsAt(o.mirror, o.sha))) w.push("scripts_changed");
  }
  if (o.manifest.database && !o.hasDatabase) w.push("new_database");
  if (cur && cur.commit !== o.sha) {
    // the same scan as the expand check (a drop, rename, narrowing or delete), plus the plain destructive lines
    const added = await addedMigrationLines(o.mirror, cur.commit, o.sha).catch(() => []);
    if (added.some((l) => DESTRUCTIVE_SQL_RE.test(l.line)) || expandViolationsIn(added).length) w.push("destructive_migration");
  }
  if (o.accessMode === "public") w.push("public_access");
  return w;
}
