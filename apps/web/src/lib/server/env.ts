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
  /**
   * App servers on private/loopback addresses (127.0.0.1, 10.x, …). Off by default (SSRF guard); an instance that runs
   * previews on its own host sets APP_SERVERS_ALLOW_PRIVATE=true. Read on each use so tests can switch it.
   */
  get appServersAllowPrivate() {
    return process.env.APP_SERVERS_ALLOW_PRIVATE === "true";
  },
};
