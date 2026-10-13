import { randomUUID } from "node:crypto";
import os from "node:os";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, credentials, db, members, servers, users, workspaces } from "@wfos/db";
import type { ServerInfo } from "@wfos/shared";
import { totp } from "@wfos/shared/totp";
import { HelperOutdatedError, HostNotAllowedError, SshAuthError, SshConnectError, probeServer, scanHostKey } from "@wfos/shared/ssh";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as login2fa } from "@/app/api/auth/login/2fa/route";
import { POST as setup2fa } from "@/app/api/me/2fa/setup/route";
import { POST as enable2fa } from "@/app/api/me/2fa/enable/route";
import { POST as reauth } from "@/app/api/me/reauth/route";
import { GET as listServers, POST as createServer } from "@/app/api/servers/route";
import { DELETE as deleteServer, PATCH as patchServer } from "@/app/api/servers/[id]/route";
import { POST as scanServer } from "@/app/api/servers/[id]/scan/route";
import { POST as verifyServer } from "@/app/api/servers/[id]/verify/route";
import { POST as checkServer } from "@/app/api/servers/[id]/check/route";
import { GET as sshKey } from "@/app/api/servers/ssh-key/route";
import { GET as prepareScript } from "@/app/api/servers/prepare-script/route";
import { setupBundle } from "@/components/settings/servers-bundle";
import { call, callWithParams, jar, queueModule, resetBrowser } from "./browser";

// the SSH client is replaced: these tests never open a connection. Error classes and sshErrorCode stay real.
vi.mock("@wfos/shared/ssh", async (importOriginal) => ({ ...(await importOriginal<typeof import("@wfos/shared/ssh")>()), scanHostKey: vi.fn(), probeServer: vi.fn() }));

const PASSWORD = "pw-123456-servers";
const HOST_KEY = Buffer.from("fake-ed25519-host-key-blob").toString("base64");
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const OTHER_FINGERPRINT = `SHA256:${"B".repeat(43)}`;
const INFO: ServerInfo = {
  helperVersion: 1,
  os: "Ubuntu 24.04",
  node: "v24.3.0",
  pnpm: "10.12.1",
  nginx: true,
  certbot: true,
  postgresPort: 5433,
  diskFreeMb: 40_000,
  memTotalMb: 7618,
  memAvailableMb: 4000,
  baseDomain: "preview.example.com",
};
const INPUT = { name: "Preview", host: "45.77.10.20", port: 22, baseDomain: "preview.example.com" };

const scan = vi.mocked(scanHostKey);
const probe = vi.mocked(probeServer);

beforeEach(() => {
  resetBrowser();
  scan.mockReset();
  probe.mockReset();
  scan.mockResolvedValue({ algo: "ssh-ed25519", key: HOST_KEY, fingerprint: FINGERPRINT });
  probe.mockResolvedValue(INFO);
  vi.mocked(queueModule.publish).mockClear();
  delete process.env.APP_SERVERS_ALLOW_PRIVATE;
});
afterEach(() => {
  delete process.env.APP_SERVERS_ALLOW_PRIVATE;
  vi.restoreAllMocks();
});

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  return ws!;
}

async function signIn(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", wsId?: string) {
  const id = wsId ?? (await workspace()).id;
  const email = `s-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: id, userId: u!.id, role });
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  return { email, userId: u!.id, wsId: id };
}

/** An Owner with 2FA, signed in, who has just confirmed with password + code (step-up valid 10 minutes). */
async function ownerWithStepUp(wsId?: string) {
  const o = await signIn("OWNER", wsId);
  const s = await call(setup2fa, "POST", "/api/me/2fa/setup");
  const secret = String(s.json.secret);
  expect((await call(enable2fa, "POST", "/api/me/2fa/enable", { code: totp(secret, Date.now() - 30_000) })).status).toBe(200);
  jar.clear();
  await call(login, "POST", "/api/auth/login", { email: o.email, password: PASSWORD });
  await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
  const stepUp = async () => expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
  return { ...o, stepUp };
}

async function addServer(wsId: string, over: Partial<typeof servers.$inferInsert> = {}) {
  const [s] = await db.insert(servers).values({ workspaceId: wsId, ...INPUT, ...over }).returning();
  return s!;
}

const rowOf = async (id: string) => (await db.select().from(servers).where(eq(servers.id, id)))[0]!;
const auditOf = (id: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, action)));

describe("servers: list, create, edit", () => {
  it("lists the workspace's servers to a Viewer without the host key blob, and nothing of other workspaces", async () => {
    const v = await signIn("VIEWER");
    const mine = await addServer(v.wsId, { hostKeyAlgo: "ssh-ed25519", hostKey: HOST_KEY, hostKeyFingerprint: FINGERPRINT, status: "ready", info: INFO });
    const other = await workspace();
    await addServer(other.id, { name: "Theirs", baseDomain: "theirs.example.com" });
    const r = await call(listServers, "GET", "/api/servers");
    expect(r.status).toBe(200);
    expect(r.json.allowPrivate).toBe(false);
    const list = r.json.servers as Record<string, unknown>[];
    expect(list.map((s) => s.id)).toEqual([mine.id]);
    expect(list[0]).toMatchObject({ name: "Preview", status: "ready", hostKeyFingerprint: FINGERPRINT, info: INFO, username: "wfos-apps", maxRunningApps: 3 });
    expect(list[0]).not.toHaveProperty("hostKey");
    expect(JSON.stringify(r.json)).not.toContain(HOST_KEY);
  });

  it("an Owner adds a server as pending; names and domains are unique per workspace", async () => {
    const o = await signIn("OWNER");
    const r = await call(createServer, "POST", "/api/servers", { ...INPUT, baseDomain: "Preview.Example.com" });
    expect(r.status).toBe(200);
    const s = r.json.server as Record<string, unknown>;
    expect(s).toMatchObject({ status: "pending", baseDomain: "preview.example.com", username: "wfos-apps", role: "dev", hostKeyFingerprint: null });
    expect(await auditOf(String(s.id), "server.added")).toHaveLength(1);
    expect(queueModule.publish).toHaveBeenCalledWith(o.wsId, { type: "server.updated", serverId: s.id, status: "pending" });

    const dupName = await call(createServer, "POST", "/api/servers", { ...INPUT, baseDomain: "other.example.com" });
    expect(dupName.status).toBe(409);
    expect(dupName.json.code).toBe("server_name_taken");
    const dupDomain = await call(createServer, "POST", "/api/servers", { ...INPUT, name: "Second" });
    expect(dupDomain.status).toBe(409);
    expect(dupDomain.json.code).toBe("server_domain_taken");
    const bad = await call(createServer, "POST", "/api/servers", { ...INPUT, name: "x", host: "-bad host", baseDomain: "nodot" });
    expect(bad.status).toBe(400);
  });

  it("refuses private and loopback addresses unless APP_SERVERS_ALLOW_PRIVATE=true", async () => {
    await signIn("OWNER");
    for (const [i, host] of ["10.0.0.5", "127.0.0.1", "192.168.1.20", "169.254.169.254", "localhost", "::1"].entries()) {
      const r = await call(createServer, "POST", "/api/servers", { ...INPUT, name: `p${i}`, host, baseDomain: `p${i}.example.com` });
      expect(r.status, host).toBe(400);
      expect(r.json.code).toBe("server_host_not_allowed");
    }
    process.env.APP_SERVERS_ALLOW_PRIVATE = "true";
    const ok = await call(createServer, "POST", "/api/servers", { ...INPUT, host: "127.0.0.1" });
    expect(ok.status).toBe(200);
    expect((await call(listServers, "GET", "/api/servers")).json.allowPrivate).toBe(true);
    // the scan passes the instance policy on to the SSH module (which resolves and checks hostnames)
    const id = String((ok.json.server as { id: string }).id);
    expect((await callWithParams(scanServer, "POST", "/x", {}, { id })).status).toBe(200);
    expect(scan).toHaveBeenCalledWith({ host: "127.0.0.1", port: 22, allowPrivate: true });
  });

  it("editing the name keeps the verification; moving the server resets it to pending", async () => {
    const o = await signIn("OWNER");
    const s = await addServer(o.wsId, { hostKeyAlgo: "ssh-ed25519", hostKey: HOST_KEY, hostKeyFingerprint: FINGERPRINT, status: "ready", info: INFO, lastCheckedAt: new Date() });
    const r1 = await callWithParams(patchServer, "PATCH", "/x", { name: "Renamed", maxRunningApps: 2 }, { id: s.id });
    expect(r1.status).toBe(200);
    expect(await rowOf(s.id)).toMatchObject({ name: "Renamed", maxRunningApps: 2, status: "ready", hostKeyFingerprint: FINGERPRINT });
    // the same host again is not a move
    expect((await callWithParams(patchServer, "PATCH", "/x", { host: INPUT.host }, { id: s.id })).status).toBe(200);
    expect((await rowOf(s.id)).status).toBe("ready");

    const r2 = await callWithParams(patchServer, "PATCH", "/x", { host: "198.51.200.7" }, { id: s.id });
    expect(r2.status).toBe(200);
    expect(await rowOf(s.id)).toMatchObject({ host: "198.51.200.7", status: "pending", hostKey: null, hostKeyAlgo: null, hostKeyFingerprint: null, info: null, lastCheckedAt: null });
    const [a] = await auditOf(s.id, "server.updated").then((rows) => rows.filter((x) => (x.details as { verificationReset?: boolean }).verificationReset));
    expect(a).toBeDefined();

    await addServer(o.wsId, { name: "Other", baseDomain: "other.example.com" });
    const dup = await callWithParams(patchServer, "PATCH", "/x", { baseDomain: "other.example.com" }, { id: s.id });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe("server_domain_taken");
    expect((await callWithParams(patchServer, "PATCH", "/x", { host: "10.1.2.3" }, { id: s.id })).json.code).toBe("server_host_not_allowed");
  });
});

describe("servers: roles and workspace isolation", () => {
  it("Viewers and Members only read; Admins check and see the key; Owners do the rest", async () => {
    const ws = await workspace();
    const s = await addServer(ws.id);
    const p = { id: s.id };
    for (const role of ["VIEWER", "MEMBER"] as const) {
      await signIn(role, ws.id);
      expect((await call(listServers, "GET", "/api/servers")).status).toBe(200);
      for (const r of [
        await call(sshKey, "GET", "/api/servers/ssh-key"),
        await call(prepareScript, "GET", "/api/servers/prepare-script"),
        await callWithParams(checkServer, "POST", "/x", {}, p),
        await call(createServer, "POST", "/api/servers", { ...INPUT, name: "n", baseDomain: "n.example.com" }),
      ]) {
        expect(r.status).toBe(403);
        expect(r.json.code).toBe("role_required");
      }
    }
    await signIn("ADMIN", ws.id);
    expect((await call(sshKey, "GET", "/api/servers/ssh-key")).status).toBe(200);
    // a pending server has no pinned key to check against
    const check = await callWithParams(checkServer, "POST", "/x", {}, p);
    expect(check.status).toBe(409);
    expect(check.json.code).toBe("server_not_verified");
    for (const r of [
      await call(createServer, "POST", "/api/servers", { ...INPUT, name: "n", baseDomain: "n.example.com" }),
      await callWithParams(patchServer, "PATCH", "/x", { name: "x" }, p),
      await callWithParams(deleteServer, "DELETE", "/x", undefined, p),
      await callWithParams(scanServer, "POST", "/x", {}, p),
      await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, p),
    ]) {
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("role_required");
    }
    expect(scan).not.toHaveBeenCalled();
  });

  it("another workspace's server is not found anywhere", async () => {
    const other = await workspace();
    const theirs = await addServer(other.id, { hostKeyAlgo: "ssh-ed25519", hostKey: HOST_KEY, hostKeyFingerprint: FINGERPRINT, status: "ready" });
    const o = await ownerWithStepUp();
    await o.stepUp();
    const p = { id: theirs.id };
    for (const r of [
      await callWithParams(patchServer, "PATCH", "/x", { name: "mine now" }, p),
      await callWithParams(deleteServer, "DELETE", "/x", undefined, p),
      await callWithParams(scanServer, "POST", "/x", {}, p),
      await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, p),
      await callWithParams(checkServer, "POST", "/x", {}, p),
      await call(sshKey, "GET", `/api/servers/ssh-key?serverId=${theirs.id}`),
      await callWithParams(checkServer, "POST", "/x", {}, { id: "not-a-uuid" }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.json.code).toBe("server_not_found");
    }
    expect(await rowOf(theirs.id)).toMatchObject({ name: "Preview", status: "ready" });
    expect(scan).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("servers: workspace key and prepare scripts", () => {
  it("creates one key per workspace on first use and builds the prepare command; the private key never leaves", async () => {
    const o = await signIn("ADMIN");
    const s = await addServer(o.wsId, { username: "apps", baseDomain: "apps.example.com" });
    const a = await call(sshKey, "GET", "/api/servers/ssh-key");
    expect(a.status).toBe(200);
    expect(String(a.json.publicKey)).toMatch(/^ssh-ed25519 AAAA\S+ wfos-ws-/);
    expect(String(a.json.fingerprint)).toMatch(/^SHA256:/);
    expect(a.json.prepareCommand).toBe(`sudo bash prepare.sh --public-key '${a.json.publicKey}' --domain 'preview.example.com'`);
    const b = await call(sshKey, "GET", `/api/servers/ssh-key?serverId=${s.id}`);
    expect(b.json.publicKey).toBe(a.json.publicKey);
    expect(b.json.prepareCommand).toBe(`sudo bash prepare.sh --public-key '${a.json.publicKey}' --domain 'apps.example.com' --user 'apps'`);
    expect(JSON.stringify(b.json)).not.toMatch(/PRIVATE KEY/);
    const rows = await db.select().from(credentials).where(and(eq(credentials.workspaceId, o.wsId), eq(credentials.kind, "ssh")));
    expect(rows).toHaveLength(1);
  });

  it("serves prepare.sh and wfos-app-helper from deploy/app-server, 404 with a code when they are missing", async () => {
    await signIn("ADMIN");
    const r = await call(prepareScript, "GET", "/api/servers/prepare-script");
    expect(r.status).toBe(200);
    const files = r.json.files as { name: string; content: string }[];
    expect(files.map((f) => f.name)).toEqual(["prepare.sh", "wfos-app-helper"]);
    for (const f of files) expect(f.content.startsWith("#!")).toBe(true);

    vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());
    const missing = await call(prepareScript, "GET", "/api/servers/prepare-script");
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("prepare_script_missing");
  });

  it("the one-paste bundle writes both files with quoted heredocs and then runs the command", () => {
    const out = setupBundle(
      [
        { name: "prepare.sh", content: "#!/bin/bash\necho $HOME\nWFOS_EOF_PREPARE_SH\n" },
        { name: "wfos-app-helper", content: "#!/bin/bash\necho hi" },
      ],
      "sudo bash prepare.sh --public-key 'k' --domain 'd'",
    );
    // a delimiter that occurs in the file is lengthened, so the heredoc cannot end early
    expect(out).toContain("cat > prepare.sh <<'WFOS_EOF_PREPARE_SH_'\n#!/bin/bash\necho $HOME\nWFOS_EOF_PREPARE_SH\nWFOS_EOF_PREPARE_SH_\n");
    expect(out).toContain("cat > wfos-app-helper <<'WFOS_EOF_WFOS_APP_HELPER'\n#!/bin/bash\necho hi\nWFOS_EOF_WFOS_APP_HELPER\n");
    expect(out.startsWith("mkdir -p ~/wfos-setup && cd ~/wfos-setup\n")).toBe(true);
    expect(out.trimEnd().endsWith("sudo bash prepare.sh --public-key 'k' --domain 'd'")).toBe(true);
  });
});

describe("servers: scan, verify, check, delete", () => {
  it("scan returns the fingerprint without storing it, and maps SSH failures to codes", async () => {
    const o = await signIn("OWNER");
    const s = await addServer(o.wsId);
    const r = await callWithParams(scanServer, "POST", "/x", {}, { id: s.id });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ algo: "ssh-ed25519", fingerprint: FINGERPRINT });
    expect(scan).toHaveBeenCalledWith({ host: INPUT.host, port: 22, allowPrivate: false });
    expect((await rowOf(s.id)).hostKeyFingerprint).toBeNull();

    scan.mockRejectedValueOnce(new SshConnectError("connect ECONNREFUSED"));
    const down = await callWithParams(scanServer, "POST", "/x", {}, { id: s.id });
    expect(down.status).toBe(502);
    expect(down.json.code).toBe("ssh_unreachable");
    scan.mockRejectedValueOnce(new HostNotAllowedError("resolves to 10.0.0.1"));
    const blocked = await callWithParams(scanServer, "POST", "/x", {}, { id: s.id });
    expect(blocked.status).toBe(400);
    expect(blocked.json.code).toBe("server_host_not_allowed");
    scan.mockRejectedValueOnce(new Error("weird"));
    const weird = await callWithParams(scanServer, "POST", "/x", {}, { id: s.id });
    expect(weird.status).toBe(502);
    expect(weird.json.code).toBe("ssh_failed");
  });

  it("verify needs a fresh step-up, and refuses a fingerprint that is not the one scanned now", async () => {
    const o = await ownerWithStepUp();
    const s = await addServer(o.wsId);
    const noStepUp = await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, { id: s.id });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.json.code).toBe("step_up_required");
    expect(scan).not.toHaveBeenCalled();

    await o.stepUp();
    const bad = await callWithParams(verifyServer, "POST", "/x", { fingerprint: "not a fingerprint" }, { id: s.id });
    expect(bad.status).toBe(400);
    const changed = await callWithParams(verifyServer, "POST", "/x", { fingerprint: OTHER_FINGERPRINT }, { id: s.id });
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe("host_key_changed");
    expect(await rowOf(s.id)).toMatchObject({ status: "pending", hostKey: null, hostKeyFingerprint: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it("verify pins the key and probes: ready with info, audited and published", async () => {
    const o = await ownerWithStepUp();
    const s = await addServer(o.wsId);
    await o.stepUp();
    const r = await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, { id: s.id });
    expect(r.status).toBe(200);
    expect(r.json.server).toMatchObject({ status: "ready", statusMessage: null, hostKeyFingerprint: FINGERPRINT, info: INFO });
    expect(r.json.server).not.toHaveProperty("hostKey");
    const row = await rowOf(s.id);
    expect(row).toMatchObject({ status: "ready", hostKeyAlgo: "ssh-ed25519", hostKey: HOST_KEY, hostKeyFingerprint: FINGERPRINT });
    expect(row.lastCheckedAt).toBeInstanceOf(Date);
    // probed as the login user, with the workspace key and the pinned host key
    const target = probe.mock.calls[0]![0];
    expect(target).toMatchObject({ host: INPUT.host, port: 22, username: "wfos-apps", hostKeyAlgo: "ssh-ed25519", hostKey: HOST_KEY, allowPrivate: false });
    expect(target.privateKey).toContain("OPENSSH PRIVATE KEY");
    const [a] = await auditOf(s.id, "server.verified");
    expect(a!.details).toMatchObject({ fingerprint: FINGERPRINT, status: "ready" });
    expect(JSON.stringify(a!.details)).not.toContain("PRIVATE KEY");
    expect(queueModule.publish).toHaveBeenCalledWith(o.wsId, { type: "server.updated", serverId: s.id, status: "ready" });
  });

  it("an outdated helper or a server prepared for another domain ends in error, with the key pinned", async () => {
    const o = await ownerWithStepUp();
    await o.stepUp();
    const s1 = await addServer(o.wsId);
    probe.mockRejectedValueOnce(new HelperOutdatedError({ ...INFO, helperVersion: 0 }));
    const r1 = await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, { id: s1.id });
    expect(r1.status).toBe(200);
    expect(await rowOf(s1.id)).toMatchObject({ status: "error", statusMessage: "helper_outdated", hostKeyFingerprint: FINGERPRINT, info: { ...INFO, helperVersion: 0 } });
    expect(await auditOf(s1.id, "server.verify_failed")).toHaveLength(1);

    const s2 = await addServer(o.wsId, { name: "Second", baseDomain: "second.example.com" });
    const r2 = await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, { id: s2.id });
    expect(r2.status).toBe(200);
    expect(r2.json.server).toMatchObject({ status: "error", statusMessage: "server_domain_mismatch" });

    const s3 = await addServer(o.wsId, { name: "Third", baseDomain: "third.example.com" });
    probe.mockRejectedValueOnce(new SshAuthError());
    const r3 = await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, { id: s3.id });
    expect(r3.json.server).toMatchObject({ status: "error", statusMessage: "ssh_auth_failed", hostKeyFingerprint: FINGERPRINT });
  });

  it("an Admin's check probes with the pinned key: error with a code, then ready again", async () => {
    const ws = await workspace();
    const s = await addServer(ws.id, { hostKeyAlgo: "ssh-ed25519", hostKey: HOST_KEY, hostKeyFingerprint: FINGERPRINT, status: "ready", info: INFO });
    await signIn("ADMIN", ws.id);
    probe.mockRejectedValueOnce(new SshConnectError("timeout"));
    const down = await callWithParams(checkServer, "POST", "/x", {}, { id: s.id });
    expect(down.status).toBe(200);
    expect(down.json.server).toMatchObject({ status: "error", statusMessage: "ssh_unreachable", info: INFO });
    expect(await auditOf(s.id, "server.checked")).toHaveLength(1);
    const up = await callWithParams(checkServer, "POST", "/x", {}, { id: s.id });
    expect(up.json.server).toMatchObject({ status: "ready", statusMessage: null });
    expect(queueModule.publish).toHaveBeenLastCalledWith(ws.id, { type: "server.updated", serverId: s.id, status: "ready" });
    expect(probe.mock.calls[0]![0]).toMatchObject({ hostKey: HOST_KEY, hostKeyAlgo: "ssh-ed25519" });
  });

  it("delete needs a fresh step-up", async () => {
    const o = await ownerWithStepUp();
    const s = await addServer(o.wsId);
    const no = await callWithParams(deleteServer, "DELETE", "/x", undefined, { id: s.id });
    expect(no.status).toBe(401);
    expect(no.json.code).toBe("step_up_required");
    expect(await db.select().from(servers).where(eq(servers.id, s.id))).toHaveLength(1);
    await o.stepUp();
    expect((await callWithParams(deleteServer, "DELETE", "/x", undefined, { id: s.id })).status).toBe(200);
    expect(await db.select().from(servers).where(eq(servers.id, s.id))).toHaveLength(0);
    expect(await auditOf(s.id, "server.removed")).toHaveLength(1);
  });

  it("an Owner without 2FA cannot verify or delete", async () => {
    const o = await signIn("OWNER");
    const s = await addServer(o.wsId);
    for (const r of [
      await callWithParams(verifyServer, "POST", "/x", { fingerprint: FINGERPRINT }, { id: s.id }),
      await callWithParams(deleteServer, "DELETE", "/x", undefined, { id: s.id }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("two_factor_required");
    }
  });
});
