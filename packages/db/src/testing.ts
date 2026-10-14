import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEST_TEMPLATE_DB = "workforce_os_test_template";

const MIGRATIONS = path.resolve(here, "../migrations");

/**
 * A copy of the migrations folder whose journal ends at `tag` (e.g. "0030_app_uptime"): a database migrated with it
 * is in the state just before the next migration, so a test can insert old-shaped rows and apply that one by hand.
 */
function migrationsUpTo(tag: string): { folder: string; cleanup: () => void } {
  const folder = mkdtempSync(path.join(os.tmpdir(), "wfos-migrations-"));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`no migration ${tag}`);
  journal.entries = journal.entries.slice(0, at + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

/** The statements of one migration file, as the migrator runs them (split on the statement breakpoints). */
export function migrationStatements(tag: string): string[] {
  return readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Create a throwaway, fully migrated database for a test run (cloned from a template that already has
 * pgvector, because a non-superuser cannot create that extension). Returns its URL and a drop function.
 * `upTo`: migrate only up to (and including) that migration tag, to test the data step of the next one.
 */
export async function createTestDatabase(opts: { upTo?: string } = {}): Promise<{ url: string; drop: () => Promise<void> }> {
  config({ path: path.resolve(here, "../../../.env"), quiet: true });
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL is not set. Point it at a Postgres role with CREATEDB that owns the template database " +
        `"${TEST_TEMPLATE_DB}" (with the vector extension). See README → Tests.`,
    );
  }
  const name = `workforce_os_test_${process.pid}_${Date.now().toString(36)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${TEST_TEMPLATE_DB}"`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const partial = opts.upTo ? migrationsUpTo(opts.upTo) : null;
  try {
    await migrate(drizzle(sql), { migrationsFolder: partial?.folder ?? MIGRATIONS });
  } finally {
    partial?.cleanup();
    await sql.end();
  }
  return {
    url,
    drop: async () => {
      // FORCE cannot terminate an autovacuum worker that just started on the database (superuser-owned): retry briefly
      for (let attempt = 1; ; attempt++) {
        try {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      await admin.end();
    },
  };
}

/** A one-connection client for a test database (raw SQL, e.g. old-shaped rows before a migration). */
export function testSql(url: string): postgres.Sql {
  return postgres(url, { max: 1, onnotice: () => {} });
}
