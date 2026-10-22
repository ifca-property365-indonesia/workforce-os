import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, expect, inject, vi } from "vitest";
import { transport } from "./transport";

// Test-only environment, set before any app module loads (dotenv never overrides these).
process.env.WFOS_ENV = "test";
process.env.WFOS_NAMESPACE = "wfos-test";
process.env.DATABASE_URL = inject("databaseUrl");
process.env.REDIS_URL = "redis://127.0.0.1:6379/14";
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "wfos-test-"));
// one storage dir per test file, removed with it: left behind they filled the host's /tmp inodes (2026-10-23)
const storageDir = process.env.STORAGE_DIR;
afterAll(() => rmSync(storageDir, { recursive: true, force: true }));
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.CLAUDE_AUTH_MODE = "oauth";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token-never-sent";
// the stub token is the instance credential; a dev .env with CLAUDE_INSTANCE_FALLBACK=false must not disable it
process.env.CLAUDE_INSTANCE_FALLBACK = "true";
process.env.ANTHROPIC_API_KEY = "";
process.env.LOG_LEVEL = "silent";

// Mock transports: Redis pub/sub + queues, SMTP, embeddings. Nothing leaves the process.
vi.mock("../src/lib/redis", async () => (await import("./transport")).redisModule);
vi.mock("@wfos/shared/mail", async () => (await import("./transport")).mailModule);
vi.mock("../src/lib/embeddings", async () => (await import("./transport")).embeddingsModule);

// Any real network call from a test is a bug.
vi.stubGlobal("fetch", async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  transport.blockedFetches.push(url);
  throw new Error(`network disabled in tests: ${url}`);
});

afterEach(() => {
  // a test that tried to reach the network fails even if it caught the error
  expect(transport.blockedFetches).toEqual([]);
});
