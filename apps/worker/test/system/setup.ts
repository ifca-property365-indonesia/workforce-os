import { execFileSync } from "node:child_process";
import { vi } from "vitest";

// System tests need root and systemd; skipping silently would hide a missing safety proof.
if (process.getuid?.() !== 0) throw new Error("System tests must run as root (they start transient systemd units).");
try {
  execFileSync("systemctl", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("System tests need systemd.");
}

// one sandbox slot is enough for sequential tests
vi.mock("../../src/runner/workspace/slots", () => ({
  acquireWorkspaceSlot: async () => true,
  releaseWorkspaceSlot: async () => {},
  workspaceConcurrency: () => 1,
}));
