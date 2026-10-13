import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { vi } from "vitest";
import { apps, appReleases, db, getOrCreateWorkspaceSshKey, members, repositories, servers, users } from "@wfos/db";
import { WFOS_HELPER_VERSION, type ServerInfo } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import * as ssh from "@wfos/shared/ssh";
import { deployDeps, deployTiming } from "../src/deploy/common";
import { makeWorkspace } from "./fixtures";

// The test files vi.mock("@wfos/shared/ssh") with sshExec / sftpPut as vi.fn(); FakeServer answers them like the
// helper v2 of contract A2 §1 would, and records every call (command, arguments, stdin).

export const HOST_KEY = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");

export interface HelperCall {
  cmd: string;
  args: string[];
  stdin: string | undefined;
}
type Reply = { code: number; stdout?: string; stderr?: string; data?: string | string[] };

/** A pretend app server: release folders, the `current` link, unit state, env file, health per running sha. */
export class FakeServer {
  calls: HelperCall[] = [];
  uploads: { path: string; mode: number | undefined; data: Buffer }[] = [];
  releases = new Set<string>();
  backups = new Set<string>();
  /** every sshExec fails as if the server were down */
  unreachable = false;
  /** the last activated sha (tests use one app at a time); per slug for the release_active guard */
  current: string | null = null;
  currentOf = new Map<string, string>();
  unit: "active" | "inactive" | "failed" = "inactive";
  env = "";
  /** sha → answers health 2xx */
  healthy: (sha: string | null) => boolean = () => true;
  /** override a reply: key "cmd" or "build-run:<step>" */
  replies: Record<string, Reply | ((c: HelperCall) => Reply | undefined)> = {};
  /** printed by build-run (to check the log redaction) */
  buildOutput = "building…\n";

  install(): void {
    vi.mocked(ssh.sshExec).mockImplementation(async (_t, command, o = {}) => {
      if (this.unreachable) throw new ssh.SshConnectError("connect ECONNREFUSED");
      const parts = command.split(" ");
      if (parts[0] !== "sudo" || parts[1] !== "-n" || parts[2] !== ssh.HELPER_PATH) throw new Error(`unexpected command ${command}`);
      const call: HelperCall = { cmd: parts[3]!, args: parts.slice(4).map((a) => a.replace(/^'|'$/g, "")), stdin: o.stdin === undefined ? undefined : String(o.stdin) };
      this.calls.push(call);
      const r = this.reply(call);
      for (const chunk of typeof r.data === "string" ? [r.data] : (r.data ?? [])) o.onData?.(chunk);
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", truncated: false };
    });
    vi.mocked(ssh.sftpPut).mockImplementation(async (_t, remotePath, data, o = {}) => {
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(data)) chunks.push(data);
      else for await (const c of data as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
      this.uploads.push({ path: remotePath, mode: o.mode, data: Buffer.concat(chunks) });
    });
  }

  private reply(c: HelperCall): Reply {
    const custom = this.replies[c.cmd === "build-run" ? `build-run:${c.args[2]}` : c.cmd] ?? this.replies[c.cmd];
    const r = typeof custom === "function" ? custom(c) : custom;
    if (r) return r;
    switch (c.cmd) {
      case "release-unpack":
        if (c.args[1] === this.currentOf.get(c.args[0]!)) return { code: 3, stderr: `wfos-app-helper: release_active: releases/${c.args[1]} is the running release\n` };
        if (!this.uploads.some((u) => u.path.endsWith(`/${c.args[0]}-${c.args[1]}.tar.gz`))) return { code: 1, stderr: "no tarball" };
        this.releases.add(c.args[1]!);
        return { code: 0, stdout: `unpacked ${c.args[1]}\n` };
      case "env-install":
        this.env = c.stdin ?? "";
        return { code: 0 };
      case "build-run":
        return { code: 0, data: this.buildOutput };
      case "release-activate": {
        if (!this.releases.has(c.args[1]!)) return { code: 3, stderr: `wfos-app-helper: release_missing: releases/${c.args[1]} is not on this server\n` };
        const prev = this.current ?? "none";
        this.current = c.args[1]!;
        this.currentOf.set(c.args[0]!, c.args[1]!);
        return { code: 0, stdout: `current -> ${c.args[1]}\n${prev}\n` };
      }
      case "unit-restart":
      case "unit-start":
        this.unit = "active";
        return { code: 0 };
      case "unit-stop":
        this.unit = "inactive";
        return { code: 0 };
      case "db-dump":
        this.backups.add(c.args[1]!);
        return { code: 0, stdout: `backup ${c.args[1]} written\n` };
      case "db-restore":
        if (!this.backups.has(c.args[1]!)) return { code: 1, stderr: `wfos-app-helper: backup_missing: no backup ${c.args[1]} for ${c.args[0]}\n` };
        return { code: 0, stdout: "restored\n" };
      case "unit-status":
        return { code: 0, stdout: `${this.unit}\n` };
      case "health": {
        const ok = this.unit === "active" && this.healthy(this.current);
        return { code: ok ? 0 : 1, stdout: `{"status":${ok ? 200 : 502}}\n` };
      }
      default:
        return { code: 0, stdout: `${c.cmd} ok\n` };
    }
  }

  /** helper commands in order (without the polling noise: repeated health calls collapse into one) */
  sequence(): string[] {
    const out: string[] = [];
    for (const c of this.calls) {
      const name = c.cmd === "build-run" ? `build-run:${c.args[2]}` : c.cmd;
      if (name === "health" && out[out.length - 1] === "health") continue;
      out.push(name);
    }
    return out;
  }

  callsOf(cmd: string): HelperCall[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }
}

/** File names inside an uploaded .tar.gz (ustar headers). */
export function tarNames(gz: Buffer): string[] {
  const tar = gunzipSync(gz);
  const names: string[] = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    if (name !== "pax_global_header") names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

// ---- a real git repository as the app's remote ----

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

export const MANIFEST = { type: "nextjs", migrate: "pnpm db:migrate", database: true, health: "/api/health", memoryMb: 512 };

/** A bare "remote" plus a work tree to commit from. commit() writes files, commits and pushes; returns the sha. */
export function makeRemote(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wfos-app-repo-"));
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", work], { env: gitEnv });
  git(work, "remote", "add", "origin", remote);
  const commit = (f: Record<string, string | null>, message = "change") => {
    for (const [name, content] of Object.entries(f)) {
      const p = path.join(work, name);
      if (content === null) execFileSync("rm", ["-f", p]);
      else {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "--allow-empty", "-m", message);
    git(work, "push", "-q", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  const first = commit(
    {
      "wfos-app.json": JSON.stringify(MANIFEST),
      "package.json": JSON.stringify({ name: "kopi", scripts: { build: "next build", start: "next start" } }),
      "prisma/migrations/0001_init/migration.sql": "CREATE TABLE orders (id int);\n",
      "src/page.tsx": "export default function Page() { return null; }\n",
      ...files,
    },
    "First version",
  );
  return { remote, work, commit, first };
}

// ---- database rows ----

export const serverInfo = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  helperVersion: WFOS_HELPER_VERSION,
  os: "Ubuntu 24.04",
  node: "v24.1.0",
  pnpm: "10.33.0",
  nginx: true,
  certbot: true,
  postgresPort: 5433,
  diskFreeMb: 20_000,
  memTotalMb: 7_800,
  memAvailableMb: 4_000,
  baseDomain: "preview.example.com",
  systemd: 257,
  firewall: true,
  appsRoot: "/srv/wfos-apps",
  ...over,
});

export const SECRET_ENV = "s3cr3t-smtp-password-value";

/** Workspace + SSH key + creator + ready server + repository (the given remote) + a new app. */
export async function makeApp(o: { remote: string; app?: Partial<typeof apps.$inferInsert>; server?: Partial<typeof servers.$inferInsert> }) {
  const ws = await makeWorkspace();
  await getOrCreateWorkspaceSshKey(db, ws.id, ws.slug);
  const [u] = await db.insert(users).values({ email: `admin-${randomUUID().slice(0, 8)}@test.local`, name: "Admin", passwordHash: "x" }).returning();
  await db.insert(members).values({ workspaceId: ws.id, userId: u!.id, role: "ADMIN" });
  const [server] = await db
    .insert(servers)
    .values({
      workspaceId: ws.id,
      name: "dev",
      host: `s-${randomUUID().slice(0, 8)}.example.com`,
      baseDomain: "preview.example.com",
      hostKeyAlgo: "ssh-ed25519",
      hostKey: HOST_KEY,
      hostKeyFingerprint: "SHA256:x",
      status: "ready",
      info: serverInfo(),
      // checked just now: the hourly server re-check (servers.test.ts, same database) leaves them alone
      lastCheckedAt: new Date(),
      ...o.server,
    })
    .returning();
  const [repo] = await db.insert(repositories).values({ workspaceId: ws.id, name: `repo-${randomUUID().slice(0, 6)}`, provider: "git", url: o.remote }).returning();
  const slug = `kopi-${randomUUID().slice(0, 6)}`;
  const [app] = await db
    .insert(apps)
    .values({
      workspaceId: ws.id,
      serverId: server!.id,
      repositoryId: repo!.id,
      name: `Toko ${slug}`,
      slug,
      domain: `${slug}.preview.example.com`,
      port: 4100 + Math.floor(Math.random() * 399),
      envEnc: encryptSecret(JSON.stringify({ SMTP_PASSWORD: SECRET_ENV, FEATURE: "on" })),
      createdBy: u!.id,
      ...o.app,
    })
    .returning();
  return { ws, user: u!, server: server!, repo: repo!, app: app! };
}

export async function queueRelease(app: { id: string; workspaceId: string }, over: Partial<typeof appReleases.$inferInsert> = {}) {
  const [r] = await db
    .insert(appReleases)
    .values({ appId: app.id, workspaceId: app.workspaceId, commit: "", branch: "main", trigger: "manual", ...over })
    .returning();
  return r!;
}

/** Fast timings and a stubbed public check (records the calls). */
export function fastDeploys() {
  deployTiming.healthIntervalMs = 1;
  deployTiming.healthTimeoutMs = 40;
  deployTiming.publicCheckRetryMs = 1;
  deployTiming.logFlushMs = 5;
  const publicCalls: { url: string; headers: Record<string, string> }[] = [];
  let status = 200;
  deployDeps.publicStatus = async (url, headers) => {
    publicCalls.push({ url, headers });
    return status;
  };
  return { publicCalls, setPublicStatus: (s: number) => (status = s) };
}
