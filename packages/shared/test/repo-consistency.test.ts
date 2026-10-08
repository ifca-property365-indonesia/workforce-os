import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (e === "node_modules" || e === "dist" || e === ".next") continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("repository consistency", () => {
  it("the Dockerfile copies every workspace package.json before pnpm install --frozen-lockfile", () => {
    const lock = read("pnpm-lock.yaml");
    const importers = [...lock.slice(lock.indexOf("importers:"), lock.indexOf("\npackages:")).matchAll(/^ {2}(\S+):$/gm)].map((m) => m[1]!).filter((i) => i !== ".");
    expect(importers.length).toBeGreaterThan(4);
    const docker = read("Dockerfile");
    expect(importers.filter((i) => !docker.includes(`COPY ${i}/package.json`))).toEqual([]);
  });

  it("every environment variable the code reads is documented in .env.example", () => {
    // set by the OS/Node, or by the platform for the in-sandbox runner (never by an operator)
    const internal = new Set(["HOME", "PATH", "USER", "NODE_ENV", "WFOS_API_PORT", "WFOS_PROXY_PORT", "WFOS_RUN_TOKEN", "WFOS_SOCKET_DIR", "WFOS_EXEC_COMMAND", "WFOS_CLAUDE_BIN"]);
    const used = new Set<string>();
    for (const dir of ["apps/web/src", "apps/worker/src", "packages/db/src", "packages/shared/src", "packages/runner/src"]) {
      for (const f of sources(path.join(root, dir))) for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) used.add(m[1]!);
    }
    const documented = new Set([...read(".env.example").matchAll(/^#? ?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
    expect([...used].filter((v) => !internal.has(v) && !documented.has(v)).sort()).toEqual([]);
  });
});
