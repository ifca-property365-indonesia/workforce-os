import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appEnvironments, apps, appReleases, db, getOrCreateWorkspaceSshKey, members, repositories, servers, users } from "@wfos/db";
import { appInstanceName, WFOS_HELPER_VERSION, type DomainCheck, type ServerInfo } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import * as ssh from "@wfos/shared/ssh";
import { deployDeps, deployTiming } from "../src/deploy/common";
import { previewCheckDeps } from "../src/deploy/preview-check";
import { makeWorkspace } from "./fixtures";

// The test files vi.mock("@wfos/shared/ssh") with sshExec / sftpPut as vi.fn(); FakeServer answers them like the
// helper v4 of contract B2 would (v3 of B1 for the calls without --slot), and records every call (command, arguments,
// stdin).

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
  // ---- helper v4: live blue-green slots (calls with --slot), the maintenance page, backups ----
  /** `<instance>:<slot>` → the sha its current-<slot> link points at */
  slotLinks = new Map<string, string>();
  /** `<instance>:<slot>` → the slot's unit: state, port (unit-install), the sha it runs (set when it starts) */
  slotUnits = new Map<string, { state: "active" | "inactive" | "failed"; port: number | null; sha: string | null }>();
  /** the single unit's port per instance (unit-install without --slot) and its state (`unit` = the last one touched) */
  singlePort = new Map<string, number>();
  singleState = new Map<string, "active" | "inactive" | "failed">();
  /** instance → what nginx serves: a port or the maintenance page */
  site = new Map<string, { port: number; maintenance: boolean }>();
  /** a db-restore ran while a unit of that instance was running (must never happen) */
  restoredUnderRunningApp: string[] = [];
  /** backup name → size (db-dump prints it) */
  backupBytes = 4321;
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

  /** the --slot of a call (null: none) */
  static slotOf(c: HelperCall): string | null {
    const i = c.args.indexOf("--slot");
    return i >= 0 ? (c.args[i + 1] ?? null) : null;
  }

  /** a sha one of the instance's slots (or its single `current`) points at */
  private activeAnywhere(inst: string, sha: string): boolean {
    if (this.currentOf.get(inst) === sha) return true;
    for (const [k, v] of this.slotLinks) if (k.startsWith(`${inst}:`) && v === sha) return true;
    return false;
  }

  /** whether any unit of the instance runs (the single one, or a slot) */
  anyRunning(inst: string): boolean {
    if (this.singleOf(inst) === "active" && this.singlePort.has(inst)) return true;
    for (const [k, u] of this.slotUnits) if (k.startsWith(`${inst}:`) && u.state === "active") return true;
    return false;
  }

  /** the single unit's state: per instance for a live one (previews keep the one shared `unit` of the A2 tests) */
  singleOf(inst: string): "active" | "inactive" | "failed" {
    return inst.endsWith("-live") ? (this.singleState.get(inst) ?? this.unit) : this.unit;
  }

  slotUnit(inst: string, slot: string) {
    return this.slotUnits.get(`${inst}:${slot}`);
  }

  private slotReply(c: HelperCall, slot: string): Reply | null {
    const inst = c.args[0]!;
    const key = `${inst}:${slot}`;
    const unit = () => this.slotUnits.get(key) ?? this.slotUnits.set(key, { state: "inactive", port: null, sha: null }).get(key)!;
    switch (c.cmd) {
      case "release-activate": {
        if (!this.releases.has(c.args[1]!)) return { code: 3, stderr: `wfos-app-helper: release_missing: releases/${c.args[1]} is not on this server\n` };
        if (slot === "blue" && this.singlePort.has(inst)) {
          // helper v4 retires the v3 single unit (it shares blue's port): refused while it runs
          if (this.singleOf(inst) === "active") return { code: 3, stderr: `wfos-app-helper: legacy_active: wfos-app-${inst} still runs on the blue slot's port\n` };
          this.singlePort.delete(inst);
          this.currentOf.delete(inst);
        }
        const prev = this.slotLinks.get(key) ?? "none";
        this.slotLinks.set(key, c.args[1]!);
        return { code: 0, stdout: `current-${slot} -> releases/${c.args[1]}\n${prev}\n` };
      }
      case "unit-install":
        unit().port = Number(c.args[1]);
        return { code: 0, stdout: `unit wfos-app-${inst}-${slot} installed\n` };
      case "unit-start":
      case "unit-restart": {
        const u = unit();
        u.state = "active";
        u.sha = this.slotLinks.get(key) ?? null;
        return { code: 0 };
      }
      case "unit-stop":
        unit().state = "inactive";
        return { code: 0 };
      case "unit-status":
        return { code: 0, stdout: `${this.slotUnits.get(key)?.state ?? "inactive"}\n` };
      default:
        return null;
    }
  }

  private reply(c: HelperCall): Reply {
    const custom = this.replies[c.cmd === "build-run" ? `build-run:${c.args[2]}` : c.cmd] ?? this.replies[c.cmd];
    const r = typeof custom === "function" ? custom(c) : custom;
    if (r) return r;
    const slot = FakeServer.slotOf(c);
    if (slot) {
      const sr = this.slotReply(c, slot);
      if (sr) return sr;
    }
    switch (c.cmd) {
      case "publish": {
        this.site.set(c.args[0]!, { port: Number(c.args[1]), maintenance: c.args.includes("--maintenance") });
        return { code: 0, stdout: "publish ok\n" };
      }
      case "unpublish":
        this.site.delete(c.args[0]!);
        return { code: 0, stdout: "unpublish ok\n" };
      case "unit-install":
        this.singlePort.set(c.args[0]!, Number(c.args[1]));
        return { code: 0, stdout: "unit-install ok\n" };
      case "slots": {
        const inst = c.args[0]!;
        const view = (slot: "blue" | "green") => {
          const u = this.slotUnits.get(`${inst}:${slot}`);
          return { unit: !!u, state: u?.state ?? "inactive", sha: this.slotLinks.get(`${inst}:${slot}`) ?? null };
        };
        const site = this.site.get(inst);
        return {
          code: 0,
          stdout: `${JSON.stringify({
            legacy: { unit: this.singlePort.has(inst), state: this.singlePort.has(inst) ? this.singleOf(inst) : "inactive", sha: this.currentOf.get(inst) ?? null },
            blue: view("blue"),
            green: view("green"),
            site: site ? { port: site.maintenance ? null : site.port, maintenance: site.maintenance } : null,
          })}\n`,
        };
      }
      case "db-backups":
        return { code: 0, stdout: `${JSON.stringify([...this.backups].map((name) => ({ name, bytes: this.backupBytes, mtime: "2026-10-14T03:30:00Z" })))}\n` };
      case "release-unpack":
        if (this.activeAnywhere(c.args[0]!, c.args[1]!)) return { code: 3, stderr: `wfos-app-helper: release_active: releases/${c.args[1]} is the running release\n` };
        if (!this.uploads.some((u) => u.path.endsWith(`/${c.args[0]}-${c.args[1]}.tar.gz`))) return { code: 1, stderr: "no tarball" };
        this.releases.add(c.args[1]!);
        return { code: 0, stdout: `unpacked ${c.args[1]}\n` };
      case "env-install":
        this.env = c.stdin ?? "";
        return { code: 0 };
      case "build-run":
        for (const [k, v] of this.slotLinks) if (k.startsWith(`${c.args[0]}:`) && v === c.args[1]) return { code: 3, stderr: `wfos-app-helper: release_active: releases/${c.args[1]} is active in a slot\n` };
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
        this.singleState.set(c.args[0]!, "active");
        return { code: 0 };
      case "unit-stop":
        this.unit = "inactive";
        this.singleState.set(c.args[0]!, "inactive");
        return { code: 0 };
      case "db-dump": {
        this.backups.add(c.args[1]!);
        const k = c.args.indexOf("--keep-kind");
        if (k >= 0) {
          // helper v4: prune that kind beyond n (oldest first)
          const prefix = c.args[k + 1]!;
          const n = Number(c.args[k + 2]);
          const ofKind = [...this.backups].filter((b) => b.startsWith(prefix));
          for (const b of ofKind.slice(0, Math.max(0, ofKind.length - n))) this.backups.delete(b);
        }
        return { code: 0, stdout: `backup ${c.args[1]} written\n${JSON.stringify({ name: c.args[1], bytes: this.backupBytes })}\n` };
      }
      case "db-restore":
        if (!this.backups.has(c.args[1]!)) return { code: 1, stderr: `wfos-app-helper: backup_missing: no backup ${c.args[1]} for ${c.args[0]}\n` };
        if (this.anyRunning(c.args[0]!)) this.restoredUnderRunningApp.push(c.args[1]!);
        return { code: 0, stdout: "restored\n" };
      case "app-remove":
        // helper v3: a live environment's database is dumped before it is dropped; the path is the last line
        if (c.args.includes("--keep-db-dump")) return { code: 0, stdout: `removed ${c.args[0]}\n/var/lib/wfos-apps/removed/${c.args[0]}-20261014T033000Z.dump\n` };
        return { code: 0, stdout: `removed ${c.args[0]}\n` };
      case "unit-status":
        return { code: 0, stdout: `${this.singleOf(c.args[0]!)}\n` };
      case "health": {
        // a slot unit listening on that port answers with the release it runs
        const port = Number(c.args[1]);
        for (const [k, u] of this.slotUnits) {
          if (k.startsWith(`${c.args[0]}:`) && u.port === port && u.state === "active") {
            const okSlot = this.healthy(u.sha);
            return { code: okSlot ? 0 : 1, stdout: `{"status":${okSlot ? 200 : 502}}\n` };
          }
        }
        const sp = this.singlePort.get(c.args[0]!);
        if (sp !== undefined && sp !== port) return { code: 1, stdout: '{"status":0}\n' };
        const live = c.args[0]!.endsWith("-live");
        const ok = this.singleOf(c.args[0]!) === "active" && this.healthy(live ? (this.currentOf.get(c.args[0]!) ?? this.current) : this.current);
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

/** repositories made by makeRemote in this test file, removed after it */
const remoteDirs: string[] = [];
afterAll(() => {
  for (const d of remoteDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bare "remote" plus a work tree to commit from. commit() writes files, commits and pushes; returns the sha. */
export function makeRemote(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wfos-app-repo-"));
  remoteDirs.push(dir);
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

type EnvInsert = typeof appEnvironments.$inferInsert;
let nextPort = 4100 + Math.floor(Math.random() * 300);

/**
 * Workspace + SSH key + creator (role ADMIN, or `role`) + ready server + repository (the given remote) + a new app
 * with its preview environment (instance = slug, <slug>.preview.example.com, password access).
 */
export async function makeApp(o: {
  remote: string;
  app?: Partial<typeof apps.$inferInsert>;
  preview?: Partial<EnvInsert>;
  server?: Partial<typeof servers.$inferInsert>;
  role?: "OWNER" | "ADMIN" | "MEMBER";
}) {
  const ws = await makeWorkspace();
  await getOrCreateWorkspaceSshKey(db, ws.id, ws.slug);
  const [u] = await db.insert(users).values({ email: `admin-${randomUUID().slice(0, 8)}@test.local`, name: "Admin", passwordHash: "x" }).returning();
  await db.insert(members).values({ workspaceId: ws.id, userId: u!.id, role: o.role ?? "ADMIN" });
  const server = await makeServer(ws.id, o.server);
  const [repo] = await db.insert(repositories).values({ workspaceId: ws.id, name: `repo-${randomUUID().slice(0, 6)}`, provider: "git", url: o.remote }).returning();
  const slug = `kopi-${randomUUID().slice(0, 6)}`;
  // only the app's own fields: the deprecated environment columns of apps are never written
  const [app] = await db
    .insert(apps)
    .values({ workspaceId: ws.id, repositoryId: repo!.id, name: `Toko ${slug}`, slug, createdBy: u!.id, ...o.app })
    .returning();
  const [preview] = await db
    .insert(appEnvironments)
    .values({
      appId: app!.id,
      workspaceId: ws.id,
      kind: "preview",
      serverId: server.id,
      instanceName: appInstanceName(app!.slug, "preview"),
      domain: `${app!.slug}.preview.example.com`,
      port: nextPort++,
      envEnc: encryptSecret(JSON.stringify({ SMTP_PASSWORD: SECRET_ENV, FEATURE: "on" })),
      createdBy: u!.id,
      ...o.preview,
    })
    .returning();
  return { ws, user: u!, server, repo: repo!, app: app!, preview: preview! };
}

/** A ready server of the workspace (host key pinned, helper v3). */
export async function makeServer(workspaceId: string, over: Partial<typeof servers.$inferInsert> = {}) {
  const [server] = await db
    .insert(servers)
    .values({
      workspaceId,
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
      ...over,
    })
    .returning();
  return server!;
}

export const LIVE_ENV = "live-only-secret-value";
export const okDns = (names: string[]): DomainCheck => ({ status: "ok", expected: ["203.0.113.10"], names: names.map((name) => ({ name, status: "ok", found: ["203.0.113.10"] })), checkedAt: new Date().toISOString() });

/** The app's live environment (instance <slug>-live, the client's domain + www., public, its own env). */
export async function makeLive(app: { id: string; slug: string; workspaceId: string }, serverId: string, over: Partial<EnvInsert> = {}) {
  const domain = `${app.slug}.client-example.org`;
  const [live] = await db
    .insert(appEnvironments)
    .values({
      appId: app.id,
      workspaceId: app.workspaceId,
      kind: "live",
      serverId,
      instanceName: appInstanceName(app.slug, "live"),
      domain,
      extraDomains: [`www.${domain}`],
      port: nextPort++,
      accessMode: "public",
      envEnc: encryptSecret(JSON.stringify({ SMTP_PASSWORD: LIVE_ENV })),
      ...over,
    })
    .returning();
  return live!;
}

/** The app's preview environment. */
export async function previewOf(appId: string) {
  const [row] = await db.select().from(appEnvironments).where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.kind, "preview")));
  return row!;
}

/** A queued release, in the app's preview unless `over.environmentId` names another environment. */
export async function queueRelease(app: { id: string; workspaceId: string }, over: Partial<typeof appReleases.$inferInsert> = {}) {
  const environmentId = over.environmentId ?? (await previewOf(app.id)).id;
  const [r] = await db
    .insert(appReleases)
    .values({ appId: app.id, workspaceId: app.workspaceId, environmentId, commit: "", branch: "main", trigger: "manual", ...over })
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
  // the page check after a preview deploys: a plain page unless a test sets its own
  const pageCalls: { url: string; headers: Record<string, string> }[] = [];
  let pages: Record<string, { status: number; body: string }> = {};
  previewCheckDeps.fetchPage = async (url, headers) => {
    pageCalls.push({ url, headers });
    return pages[new URL(url).pathname] ?? { status: 200, body: "<html><head><title>App</title></head><body>ok</body></html>" };
  };
  return { publicCalls, setPublicStatus: (s: number) => (status = s), pageCalls, setPages: (p: typeof pages) => (pages = p) };
}

/** Another app with an environment on `serverId` in `status` (for the per-server running limit). */
export async function makeOtherEnv(workspaceId: string, serverId: string, status: "running" | "deploying" | "stopped") {
  const slug = `other-${randomUUID().slice(0, 8)}`;
  const [app] = await db.insert(apps).values({ workspaceId, name: `Other ${slug}`, slug }).returning();
  const [e] = await db
    .insert(appEnvironments)
    .values({ appId: app!.id, workspaceId, kind: "preview", serverId, instanceName: slug, domain: `${slug}.preview.example.com`, port: nextPort++, status })
    .returning();
  return { app: app!, env: e! };
}
