// Bundles the in-sandbox runner (entry + Agent SDK + zod) into one file. The native Claude Code binary is
// not bundled: the worker bind-mounts its package directory read-only and passes its path.
import { build } from "esbuild";

await build({
  entryPoints: ["src/entry.ts"],
  outfile: "dist/runner.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: 'import { createRequire as __wfosCreateRequire } from "node:module"; const require = __wfosCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
console.log("built dist/runner.mjs");
