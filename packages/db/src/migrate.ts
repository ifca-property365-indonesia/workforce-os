import { config } from "dotenv";
import { assertNotProductionTarget } from "@wfos/shared/runtime";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, getSql } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
assertNotProductionTarget();

async function main() {
  const sql = getSql();
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await migrate(getDb(), { migrationsFolder: path.resolve(here, "../migrations") });
  console.log("migrations applied");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
