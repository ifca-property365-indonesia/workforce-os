import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runApprovedCommand } from "../../src/runner/workspace/exec";
import { runLayout } from "../../src/runner/workspace/layout";
import { launchUnit, stopUnit, unitActive } from "../../src/runner/workspace/unit";
import { isBlockedAddress } from "@wfos/shared/netguard";
import type { GatewayEvent } from "../../src/runner/workspace/gateway";
import { cleanupWorkspace, REPO_ROOT, testHost } from "./host";

/**
 * Proves the Workspace-mode sandbox boundary on this host with real systemd units (DECISIONS D14).
 * Every command runs exactly the way an approved agent command runs.
 */
const host = testHost();
const WS = randomUUID();
const TASK_A = randomUUID();
const TASK_B = randomUUID();
const events: GatewayEvent[] = [];
let allowedServer: http.Server;
let allowedPort = 0;

async function sh(command: string, opts: { task?: string; egress?: string[]; timeoutSec?: number } = {}) {
  return runApprovedCommand({
    workspaceId: WS,
    taskId: opts.task ?? TASK_A,
    command,
    egressAllow: opts.egress ?? [],
    host,
    timeoutSec: opts.timeoutSec ?? 60,
    gateway: {
      // "allowed.test" stands in for an allow-listed registry; it resolves to a local server (no internet)
      resolve: async (h) => (h === "allowed.test" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]),
      isBlocked: (ip) => ip !== "127.0.0.1" && isBlockedAddress(ip),
      connectPort: allowedPort,
      onEvent: (e) => events.push(e),
    },
  });
}

beforeAll(async () => {
  allowedServer = http.createServer((_req, res) => res.end("hello-from-allowed"));
  await new Promise<void>((r) => allowedServer.listen(0, "127.0.0.1", r));
  allowedPort = (allowedServer.address() as AddressInfo).port;
});
afterAll(async () => {
  allowedServer.close();
  await cleanupWorkspace(host, WS);
});

describe("sandbox: platform secrets are unreachable", () => {
  it.each([
    ["production .env", "/root/apps/workforce-os/.env"],
    ["this checkout's .env", path.join(REPO_ROOT, ".env")],
    ["/etc/shadow", "/etc/shadow"],
  ])("cannot read %s", async (_label, file) => {
    const r = await sh(`cat ${file}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toMatch(/Permission denied|No such file/);
  });

  it("cannot see or read the worker process (it holds DATABASE_URL and ENCRYPTION_KEY)", async () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
    const r = await sh(`test -e /proc/${process.pid} && echo VISIBLE; cat /proc/${process.pid}/environ; ls /proc | grep -c '^[0-9]'`);
    expect(r.output).not.toContain("VISIBLE");
    expect(r.output).not.toContain(process.env.DATABASE_URL!);
    expect(Number(r.output.trim().split("\n").pop())).toBeLessThan(10);
  });

  it("has an environment with no platform secrets", async () => {
    const r = await sh("printenv");
    expect(r.exitCode).toBe(0);
    for (const k of ["DATABASE_URL", "ENCRYPTION_KEY", "AUTH_SECRET", "REDIS_URL", "TEST_DATABASE_ADMIN_URL", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "WFOS_RUN_TOKEN"]) {
      expect(r.output).not.toMatch(new RegExp(`^${k}=`, "m"));
    }
    for (const v of [process.env.DATABASE_URL, process.env.ENCRYPTION_KEY].filter(Boolean)) expect(r.output).not.toContain(v);
  });

  it("cannot reach Postgres, Redis or the web app on the host", async () => {
    for (const port of [5432, 6379, 3010]) {
      const r = await sh(`exec 3<>/dev/tcp/127.0.0.1/${port} && echo CONNECTED`);
      expect(r.output, `port ${port}`).not.toContain("CONNECTED");
    }
    const sock = await sh("ls /run/postgresql /var/run/postgresql 2>&1; psql -h /var/run/postgresql -U postgres -c 'select 1' 2>&1");
    expect(sock.output).not.toMatch(/\(1 row\)/);
  });

  it("cannot see other runs' sockets or the platform runtime dir", async () => {
    const r = await sh(`ls ${host.runtimeDir}/runs && echo LISTED`);
    expect(r.output).not.toContain("LISTED");
  });
});

describe("sandbox: network", () => {
  it("has no direct internet access", async () => {
    const r = await sh("curl --noproxy '*' -sS -m 5 https://example.com/ && echo REACHED");
    expect(r.output).not.toContain("REACHED");
  });

  it("reaches an allow-listed host only through the egress proxy", async () => {
    const r = await sh("curl -sS -m 10 -p http://allowed.test:443/", { egress: ["allowed.test"] });
    expect(r.output).toContain("hello-from-allowed");
    expect(events.some((e) => e.kind === "egress_allowed" && e.detail.startsWith("allowed.test"))).toBe(true);
  });

  it("is refused for hosts that are not allow-listed", async () => {
    events.length = 0;
    const r = await sh("curl -sS -m 10 https://example.com/ && echo REACHED", { egress: ["allowed.test"] });
    expect(r.output).not.toContain("REACHED");
    expect(r.output).toMatch(/403|CONNECT tunnel failed/);
    expect(events.some((e) => e.kind === "egress_denied" && e.detail.includes("example.com"))).toBe(true);
  });

  it("cannot use the proxy to reach host services", async () => {
    const r = await sh("curl -sS -m 5 -p http://127.0.0.1:6379/ && echo REACHED", { egress: ["allowed.test"] });
    expect(r.output).not.toContain("REACHED");
  });
});

describe("sandbox: filesystem", () => {
  it("writes inside the workspace and its private /tmp", async () => {
    const r = await sh("echo data > inside.txt && cat inside.txt && touch /tmp/x && echo TMP_OK");
    expect(r.output).toContain("data");
    expect(r.output).toContain("TMP_OK");
  });

  it.each(["/etc/wfos-probe", "/root/wfos-probe", "/var/lib/wfos-probe", "/usr/local/bin/wfos-probe", "/mnt/wfos/runner/wfos-probe"])("cannot write %s", async (p) => {
    const r = await sh(`touch ${p} && echo WROTE`);
    expect(r.output).not.toContain("WROTE");
    expect(existsSync(p)).toBe(false);
  });

  it("cannot read another task's workspace", async () => {
    await sh("echo task-a-secret > secret.txt", { task: TASK_A });
    const a = runLayout(host, { runId: randomUUID(), workspaceId: WS, taskId: TASK_A });
    const r = await sh(`cat ${a.sandboxRepoDir}/secret.txt; cat ${a.hostStateDir}/repo/secret.txt; ls /var/lib/private`, { task: TASK_B });
    expect(r.output).not.toContain("task-a-secret");
  });

  it("runs approved git commands with hooks disabled", async () => {
    const r = await sh(
      "git init -q . 2>/dev/null; printf '#!/bin/sh\\ntouch hook-ran\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && " +
        "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m probe && ls",
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("hook-ran");
  });

  it("cannot gain privileges", async () => {
    const r = await sh("sudo -n true && echo ROOT; su -c true root </dev/null && echo ROOT; id -u");
    expect(r.output).not.toContain("ROOT");
    expect(r.output.trim().split("\n").pop()).not.toBe("0");
  });
});

describe("sandbox: resources and stop", () => {
  it("is killed when it exceeds its memory limit", async () => {
    const r = await sh("python3 -c 'b = bytearray(1200 * 1024 * 1024); print(\"ALLOCATED\")'");
    expect(r.output).not.toContain("ALLOCATED");
    expect(r.exitCode).not.toBe(0);
  });

  it("stopping a run kills its whole process tree", async () => {
    const layout = runLayout(host, { runId: randomUUID(), workspaceId: WS, taskId: TASK_A });
    const child = launchUnit({
      host,
      layout,
      env: { PATH: "/usr/bin:/bin" },
      command: ["/bin/sh", "-c", "sleep 300 & sleep 300 & (sleep 300; echo) & wait"],
      workDir: "/",
    });
    const exited = new Promise((r) => child.on("exit", r));
    await new Promise((r) => setTimeout(r, 1500));
    expect(await unitActive(layout.unitName)).toBe(true);
    // the dynamic user name only resolves while the unit runs: count by numeric UID
    const uid = execFileSync("id", ["-u", layout.userName]).toString().trim();
    const before = execFileSync("pgrep", ["-c", "-U", uid]).toString().trim();
    expect(Number(before)).toBeGreaterThanOrEqual(3);
    await stopUnit(layout.unitName);
    await exited;
    expect(await unitActive(layout.unitName)).toBe(false);
    let left = "0";
    try {
      left = execFileSync("pgrep", ["-c", "-U", uid]).toString().trim();
    } catch {
      left = "0"; // pgrep exits 1 when nothing matches
    }
    expect(left).toBe("0");
  });
});
