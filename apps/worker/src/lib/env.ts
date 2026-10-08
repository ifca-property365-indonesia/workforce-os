import { config } from "dotenv";
import { assertNotProductionTarget, wfosNamespace } from "@wfos/shared/runtime";
import { instanceClaudeCredential, type ClaudeCredential } from "@wfos/db/claude";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../../.env"), quiet: true });
assertNotProductionTarget();

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
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  perEmployeeConcurrency: Number(process.env.PER_EMPLOYEE_CONCURRENCY ?? 1),
  logLevel: process.env.LOG_LEVEL ?? "info",
  namespace: wfosNamespace(),
};

/**
 * Env for the Claude Agent SDK subprocess: an explicit allow-list, never process.env. It carries only the
 * credential of the workspace whose run this is; platform secrets (DATABASE_URL, ENCRYPTION_KEY, AUTH_SECRET,
 * REDIS_URL, SMTP, other tenants' credentials) are never included.
 */
export function agentEnv(home: string, credential: ClaudeCredential): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    CLAUDE_AGENT_SDK_CLIENT_APP: "workforce-os/0.1.0",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (credential.type === "api_key") e.ANTHROPIC_API_KEY = credential.secret;
  else e.CLAUDE_CODE_OAUTH_TOKEN = credential.secret;
  return e;
}

/** Instance fallback status, for the startup log only. */
export function instanceCredentialSummary(): { mode: string; present: boolean; fallbackEnabled: boolean } {
  const inst = instanceClaudeCredential()!;
  return { mode: inst.type, present: !!inst.secret, fallbackEnabled: inst.enabled };
}
