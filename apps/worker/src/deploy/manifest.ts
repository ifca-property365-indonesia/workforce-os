import { z } from "zod";
import { APP_MANIFEST_FILE, appManifestSchema, type AppManifest, type ReleaseWarning } from "@wfos/shared";
import { rootGit } from "../runner/workspace/git";

const MAX_MANIFEST_BYTES = 16 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
/** added lines in a migration that can lose data */
export const DESTRUCTIVE_SQL_RE = /DROP TABLE|DROP COLUMN|TRUNCATE|ALTER TABLE .* DROP|DELETE FROM/i;
/** where Prisma, Drizzle and plain SQL migrations live (at any depth of the repository) */
const MIGRATION_PATHSPECS = [":(glob)**/prisma/migrations/**", ":(glob)**/drizzle/**", ":(glob)**/migrations/**"];

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

/** Lines added to migration files between two commits that match DESTRUCTIVE_SQL_RE. */
export async function destructiveMigrationLines(mirror: string, from: string, to: string): Promise<string[]> {
  const diff = await rootGit(["-C", mirror, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", from, to, "--", ...MIGRATION_PATHSPECS], { maxBuffer: 64 * 1024 * 1024 });
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .filter((l) => DESTRUCTIVE_SQL_RE.test(l));
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
  if (cur && cur.commit !== o.sha && (await destructiveMigrationLines(o.mirror, cur.commit, o.sha).catch(() => [])).length) w.push("destructive_migration");
  if (o.accessMode === "public") w.push("public_access");
  return w;
}
