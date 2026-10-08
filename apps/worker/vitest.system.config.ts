import { defineConfig } from "vitest/config";

/**
 * System tests: real systemd units, real Claude Code CLI against a local stub API. Need root and systemd
 * (the production host or a fresh Ubuntu VM). They never call the real Claude service or the internet.
 */
export default defineConfig({
  test: {
    include: ["test/system/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts", "test/system/setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
