import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Live eval tier (`pnpm --filter @wfos/worker eval:live`): calls the real Claude service, so it is opt-in and
 * never part of `pnpm test` (whose config only includes test/**). Deliberately without test/setup.ts, which
 * replaces the Claude credential with a stub; the live test sets the rest of the test environment itself.
 * The throwaway test database is only created when EVAL_LIVE=1 (otherwise every case is skipped).
 */
const live = process.env.EVAL_LIVE === "1";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["evals/**/*.live.test.ts"],
    globalSetup: live ? ["test/global-setup.ts"] : [],
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 120_000,
  },
});
