import { existsSync, readFileSync } from "node:fs";

/**
 * Instance namespace for everything shared on one Redis server: BullMQ queue prefix and
 * pub/sub channels (which ignore the DB index). Empty in production for backwards compatibility.
 */
export function wfosNamespace(): string {
  return process.env.WFOS_NAMESPACE?.trim() ?? "";
}

export function queuePrefix(): string {
  return wfosNamespace() || "bull";
}

/** Postgres target without credentials: host:port/database. */
export function pgTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
}

/** Redis target without credentials: host:port/db. */
export function redisTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "6379"}/${u.pathname.replace(/^\//, "") || "0"}`;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Refuse to start a development or test process that points at production data.
 * Active only when WFOS_ENV is development/test, so production boots unchanged.
 * Compares DATABASE_URL / REDIS_URL / namespace against the production env file (WFOS_PROD_ENV_FILE).
 */
export function assertNotProductionTarget(env: NodeJS.ProcessEnv = process.env): void {
  const mode = env.WFOS_ENV;
  if (mode !== "development" && mode !== "test") return;
  const db = env.DATABASE_URL;
  const redis = env.REDIS_URL;
  if (!db || !redis) throw new Error(`[wfos] ${mode}: DATABASE_URL and REDIS_URL must be set explicitly.`);
  if (!env.WFOS_NAMESPACE?.trim()) throw new Error(`[wfos] ${mode}: WFOS_NAMESPACE must be set so queues and pub/sub never mix with production.`);
  const prodFile = env.WFOS_PROD_ENV_FILE;
  if (!prodFile || !existsSync(prodFile)) return;
  const prod = parseEnvFile(prodFile);
  const clashes: string[] = [];
  if (prod.DATABASE_URL && pgTarget(prod.DATABASE_URL) === pgTarget(db)) clashes.push(`DATABASE_URL (${pgTarget(db)})`);
  if (prod.REDIS_URL && redisTarget(prod.REDIS_URL) === redisTarget(redis) && (prod.WFOS_NAMESPACE ?? "") === (env.WFOS_NAMESPACE ?? "")) {
    clashes.push(`REDIS_URL (${redisTarget(redis)})`);
  }
  if ((prod.WFOS_NAMESPACE ?? "") === (env.WFOS_NAMESPACE ?? "").trim()) clashes.push("WFOS_NAMESPACE");
  if (clashes.length) throw new Error(`[wfos] refusing to start in ${mode} mode: ${clashes.join(", ")} equal the production values in ${prodFile}.`);
}
