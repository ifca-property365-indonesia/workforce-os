import "server-only";
import { assertNotProductionTarget, wfosNamespace } from "@wfos/shared/runtime";

assertNotProductionTarget();

export const serverEnv = {
  appUrl: process.env.APP_URL ?? "http://localhost:3010",
  authSecret: process.env.AUTH_SECRET ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0",
  namespace: wfosNamespace(),
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  /** Public self-service signup. Off by default: admins add members in Settings → Members. */
  allowSignup: process.env.ALLOW_SIGNUP === "true",
  claudeAuthMode: (process.env.CLAUDE_AUTH_MODE ?? "oauth") as "oauth" | "api_key",
  claudeCredentialPresent:
    (process.env.CLAUDE_AUTH_MODE ?? "oauth") === "api_key" ? !!process.env.ANTHROPIC_API_KEY : !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
};
