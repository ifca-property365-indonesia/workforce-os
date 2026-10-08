import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEST_TEMPLATE_DB = "workforce_os_test_template";

/**
 * Create a throwaway, fully migrated database for a test run (cloned from a template that already has
 * pgvector, because a non-superuser cannot create that extension). Returns its URL and a drop function.
 */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
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
  await migrate(drizzle(sql), { migrationsFolder: path.resolve(here, "../migrations") });
  await sql.end();
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
