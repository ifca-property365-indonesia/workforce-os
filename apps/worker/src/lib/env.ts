import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../../.env"), quiet: true });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const env = {
  databaseUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0",
  appUrl: process.env.APP_URL ?? "http://localhost:3010",
  storageDir: path.resolve(process.env.STORAGE_DIR ?? path.resolve(here, "../../../../storage")),
  claudeAuthMode: (process.env.CLAUDE_AUTH_MODE ?? "oauth") as "oauth" | "api_key",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  perEmployeeConcurrency: Number(process.env.PER_EMPLOYEE_CONCURRENCY ?? 1),
  logLevel: process.env.LOG_LEVEL ?? "info",
};

/** Env for the Claude Agent SDK subprocess: only what it needs, with the selected credential. */
export function agentEnv(home: string): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    CLAUDE_AGENT_SDK_CLIENT_APP: "workforce-os/0.1.0",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (env.claudeAuthMode === "api_key") {
    e.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else {
    e.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return e;
}

export function claudeCredentialPresent(): boolean {
  return env.claudeAuthMode === "api_key" ? !!process.env.ANTHROPIC_API_KEY : !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}
