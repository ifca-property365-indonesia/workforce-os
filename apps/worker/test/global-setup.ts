import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { TestProject } from "vitest/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = "workforce_os_test_template";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Creates a throwaway database (cloned from a template that has pgvector), migrates it,
 * and drops it afterwards. Requires TEST_DATABASE_ADMIN_URL (a role with CREATEDB).
 * There is deliberately no "skip": the safety suites must run.
 */
export default async function setup(project: TestProject) {
  config({ path: path.resolve(here, "../../../.env"), quiet: true });
  const admin = process.env.TEST_DATABASE_ADMIN_URL;
  if (!admin) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL is not set. Point it at a Postgres role with CREATEDB that owns the template database " +
        `"${TEMPLATE}" (with the vector extension). See README → Tests.`,
    );
  }
  const name = `workforce_os_test_${process.pid}_${Date.now().toString(36)}`;
  const adminSql = postgres(admin, { max: 1, onnotice: () => {} });
  await adminSql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE}"`);
  const u = new URL(admin);
  u.pathname = `/${name}`;
  const url = u.toString();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: path.resolve(here, "../../../packages/db/migrations") });
  await sql.end();
  project.provide("databaseUrl", url);

  return async () => {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await adminSql.end();
  };
}
