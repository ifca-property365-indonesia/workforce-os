import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // one throwaway database shared by all files, so files run one after another
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
