import { randomBytes } from "node:crypto";
import { inject, vi } from "vitest";
import { jar } from "./browser";

process.env.WFOS_ENV = "test";
process.env.WFOS_NAMESPACE = "wfos-test";
process.env.DATABASE_URL = inject("databaseUrl");
process.env.REDIS_URL = "redis://127.0.0.1:6379/14";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
process.env.APP_URL = "http://localhost:3010";

vi.mock("server-only", () => ({}));
// one in-memory "browser" cookie jar shared by all route calls in a test
vi.mock("next/headers", () => ({
  cookies: async () => jar,
  headers: async () => new Headers(),
}));
// in-memory Redis for rate limits; queues/pub-sub record only
vi.mock("@/lib/server/queue", async () => (await import("./browser")).queueModule);
