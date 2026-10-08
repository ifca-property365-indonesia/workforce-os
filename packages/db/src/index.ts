import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };
export { audit } from "./audit";
export { seedSampleData, seedPrices, nextCronRun } from "./sample";
export * from "./claude";

export type DB = PostgresJsDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __wfosDb?: DB; __wfosSql?: postgres.Sql };

export function getSql(): postgres.Sql {
  if (!globalForDb.__wfosSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__wfosSql = postgres(url, {
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return globalForDb.__wfosSql;
}

export function getDb(): DB {
  if (!globalForDb.__wfosDb) globalForDb.__wfosDb = drizzle(getSql(), { schema });
  return globalForDb.__wfosDb;
}

/** Lazy proxy so importing modules does not require DATABASE_URL at build time. */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});
