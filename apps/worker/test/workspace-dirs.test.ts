import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareWorkspaceDirs } from "../src/runner/workspace/query";
import { runLayout, type SandboxHost } from "../src/runner/workspace/layout";
import { unitProperties } from "../src/runner/workspace/unit";

function host(): SandboxHost {
  const base = mkdtempSync(path.join(os.tmpdir(), "wfos-state-"));
  return { stateBase: base, runtimeDir: path.join(base, "run"), nodePrefix: "/usr", runnerDir: path.join(base, "runner"), claudeDir: "/nonexistent" };
}

describe("workspace directories", () => {
  it("creates a new workspace with repo/ and home/.claude, seeding skills once", async () => {
    const h = host();
    mkdirSync(path.join(h.runnerDir, "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(h.runnerDir, "skills", "pdf", "SKILL.md"), "# pdf");
    const l = runLayout(h, { runId: randomUUID(), workspaceId: randomUUID(), taskId: randomUUID() });
    await prepareWorkspaceDirs(l, { skillsDir: path.join(h.runnerDir, "skills") });
    expect(readdirSync(l.hostStateDir).sort()).toEqual(["home", "repo"]);
    expect(existsSync(path.join(l.hostStateDir, "home/.claude/skills/pdf/SKILL.md"))).toBe(true);
  });

  it("never writes into an existing workspace (symlink planted by the agent)", async () => {
    const h = host();
    const l = runLayout(h, { runId: randomUUID(), workspaceId: randomUUID(), taskId: randomUUID() });
    const victim = mkdtempSync(path.join(os.tmpdir(), "wfos-victim-"));
    mkdirSync(l.hostStateDir, { recursive: true });
    // the agent replaced its home with a link to a directory root must not touch
    symlinkSync(victim, path.join(l.hostStateDir, "home"));
    await prepareWorkspaceDirs(l, { skillsDir: path.join(h.runnerDir, "skills") });
    expect(readdirSync(victim)).toEqual([]);
    expect(existsSync(path.join(l.hostStateDir, "repo"))).toBe(false);
  });
});

describe("unit properties", () => {
  it("contains every isolation flag the spike relies on", () => {
    const h = host();
    const l = runLayout(h, { runId: randomUUID(), workspaceId: randomUUID(), taskId: randomUUID() });
    const props = unitProperties(h, l);
    for (const p of [
      "DynamicUser=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "ProtectProc=invisible",
      "NoNewPrivileges=yes", "CapabilityBoundingSet=", "PrivateNetwork=yes", "RestrictNamespaces=yes", "MemorySwapMax=0", "KillMode=control-group",
      `InaccessiblePaths=-${h.runtimeDir}`, "InaccessiblePaths=-/run/postgresql", "InaccessiblePaths=-/run/redis", "TemporaryFileSystem=/mnt",
    ]) expect(props, p).toContain(p);
    expect(props.some((p) => p.startsWith("MemoryMax="))).toBe(true);
    expect(props.some((p) => p.startsWith("RuntimeMaxSec="))).toBe(true);
  });

  it("refuses extra mounts outside /mnt/wfos", () => {
    const h = host();
    const l = runLayout(h, { runId: randomUUID(), workspaceId: randomUUID(), taskId: randomUUID() });
    expect(() => unitProperties(h, l, undefined, undefined, [{ host: "/etc", sandbox: "/etc" }])).toThrow();
  });

  it("rejects ids that are not UUIDs (no path traversal into state paths)", () => {
    expect(() => runLayout(host(), { runId: randomUUID(), workspaceId: "../../etc", taskId: randomUUID() })).toThrow();
  });
});

describe("workspace garbage collection", () => {
  it("removes expired and discarded workspaces and keeps deliverables", async () => {
    const { collectWorkspaces } = await import("../src/runner/workspace/gc");
    const { db, tasks } = await import("@wfos/db");
    const { eq } = await import("drizzle-orm");
    const { makeEmployee, makeTask, makeWorkspace } = await import("./fixtures");
    const h = host();
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const old = await makeTask(ws.id, emp.id, { status: "DONE", workspaceStatus: "active", completedAt: new Date(Date.now() - 30 * 86_400_000), deliverables: [{ id: "d", kind: "code", title: "x", content: "diff", createdAt: new Date().toISOString() }] });
    const recent = await makeTask(ws.id, emp.id, { status: "DONE", workspaceStatus: "active", completedAt: new Date() });
    const discarded = await makeTask(ws.id, emp.id, { status: "CANCELLED", workspaceStatus: "discarded", completedAt: new Date() });
    const running = await makeTask(ws.id, emp.id, { status: "RUNNING", workspaceStatus: "active" });
    const dirs = new Map<string, string>();
    for (const t of [old, recent, discarded, running]) {
      const l = runLayout(h, { runId: t.id, workspaceId: ws.id, taskId: t.id });
      await prepareWorkspaceDirs(l);
      dirs.set(t.id, l.hostStateDir);
    }
    await collectWorkspaces({ host: h });
    expect(existsSync(dirs.get(old.id)!)).toBe(false);
    expect(existsSync(dirs.get(discarded.id)!)).toBe(false);
    expect(existsSync(dirs.get(recent.id)!)).toBe(true);
    expect(existsSync(dirs.get(running.id)!)).toBe(true);
    const [o] = await db.select().from(tasks).where(eq(tasks.id, old.id));
    expect(o!.workspaceStatus).toBe("archived");
    expect(o!.deliverables).toHaveLength(1);
  });
});
