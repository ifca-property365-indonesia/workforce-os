import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { credentials, db, getOrCreateWorkspaceSshKey, members, servers, users, workspaceSshPrivateKey } from "@wfos/db";
import { WFOS_HELPER_VERSION, type NotifyJob, type RealtimeEvent, type ServerInfo } from "@wfos/shared";
import { decryptSecret } from "@wfos/shared/server";
import * as ssh from "@wfos/shared/ssh";
import { recheckServers, SERVER_RECHECK_EVERY_MS } from "../src/scheduler/servers";
import { env } from "../src/lib/env";
import { makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

// SSH is never real here: probeServer is mocked, the error classes and sshErrorCode are the real ones.
vi.mock("@wfos/shared/ssh", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/ssh")>();
  return { ...real, probeServer: vi.fn() };
});
const probe = vi.mocked(ssh.probeServer);

beforeEach(() => {
  resetTransport();
  probe.mockReset();
});

const HOST_KEY = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");
const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
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
const longAgo = () => new Date(Date.now() - SERVER_RECHECK_EVERY_MS - 60_000);

async function member(workspaceId: string, role: "OWNER" | "ADMIN" | "MEMBER") {
  const [u] = await db.insert(users).values({ email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.local`, name: role, passwordHash: "x" }).returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role });
  return u!;
}

async function setup(over: Partial<typeof servers.$inferInsert> = {}) {
  const ws = await makeWorkspace();
  await getOrCreateWorkspaceSshKey(db, ws.id, ws.slug);
  const owner = await member(ws.id, "OWNER");
  const owner2 = await member(ws.id, "OWNER");
  await member(ws.id, "ADMIN");
  const [s] = await db
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
      info: info(),
      lastCheckedAt: longAgo(),
      ...over,
    })
    .returning();
  return { ws, server: s!, owners: [owner.id, owner2.id].sort() };
}

const row = async (id: string) => (await db.select().from(servers).where(eq(servers.id, id)))[0]!;
const notifications = () => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob);
const serverEvents = (serverId: string) =>
  transport.published.map((p) => p.ev as RealtimeEvent).filter((e) => e.type === "server.updated" && e.serverId === serverId);

describe("hourly server re-check", () => {
  it("a healthy server stays ready: info and lastCheckedAt are refreshed, server.updated is published", async () => {
    const { ws, server } = await setup();
    probe.mockResolvedValue(info({ diskFreeMb: 12_345 }));
    const out = await recheckServers();
    expect(out.find((o) => o.serverId === server.id)).toEqual({ serverId: server.id, status: "ready", code: null, wentDown: false });
    const r = await row(server.id);
    expect(r).toMatchObject({ status: "ready", statusMessage: null });
    expect(r.info?.diskFreeMb).toBe(12_345);
    expect(r.lastCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(serverEvents(server.id)).toEqual([{ type: "server.updated", serverId: server.id, status: "ready" }]);
    expect(notifications().filter((n) => n.workspaceId === ws.id)).toEqual([]);
  });

  it("probes with the pinned host key, the workspace's own private key and the instance's private-address policy", async () => {
    const { ws, server } = await setup();
    probe.mockResolvedValue(info());
    env.appServersAllowPrivate = true;
    try {
      await recheckServers();
    } finally {
      env.appServersAllowPrivate = false;
    }
    const call = probe.mock.calls.find((c) => c[0].host === server.host)!;
    const [cred] = await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id)).then((rs) => rs.filter((c) => c.kind === "ssh"));
    expect(call[0]).toEqual({
      host: server.host,
      port: 22,
      username: "wfos-apps",
      privateKey: decryptSecret(cred!.secretEnc!),
      hostKeyAlgo: "ssh-ed25519",
      hostKey: HOST_KEY,
      allowPrivate: true,
    });
  });

  it("ready → error: status error with the code, and each Owner (only Owners) is notified once", async () => {
    const { ws, server, owners } = await setup();
    probe.mockRejectedValue(new ssh.SshConnectError("connect ECONNREFUSED 127.0.0.1:22"));
    const out = await recheckServers();
    expect(out.find((o) => o.serverId === server.id)).toEqual({ serverId: server.id, status: "error", code: "ssh_unreachable", wentDown: true });
    expect(await row(server.id)).toMatchObject({ status: "error", statusMessage: "ssh_unreachable" });
    const sent = notifications().filter((n) => n.workspaceId === ws.id);
    expect(sent.map((n) => n.userId).sort()).toEqual(owners);
    expect(sent[0]).toMatchObject({ kind: "notify", notificationKind: "incident", link: "/settings?tab=servers" });
    expect(sent[0]!.subject).toContain("dev");
    expect(sent[0]!.text).toContain("could not be reached");
    expect(serverEvents(server.id)).toEqual([{ type: "server.updated", serverId: server.id, status: "error" }]);

    // still down an hour later: stays error, nobody is notified again
    resetTransport();
    await db.update(servers).set({ lastCheckedAt: longAgo() }).where(eq(servers.id, server.id));
    await recheckServers();
    expect(await row(server.id)).toMatchObject({ status: "error", statusMessage: "ssh_unreachable" });
    expect(notifications().filter((n) => n.workspaceId === ws.id)).toEqual([]);
  });

  it("error → ready when the server passes again", async () => {
    const { server } = await setup({ status: "error", statusMessage: "ssh_unreachable" });
    probe.mockResolvedValue(info());
    await recheckServers();
    expect(await row(server.id)).toMatchObject({ status: "ready", statusMessage: null });
  });

  it.each([
    ["host key changed", () => new ssh.HostKeyMismatchError(), "host_key_mismatch"],
    ["key refused", () => new ssh.SshAuthError(), "ssh_auth_failed"],
    ["helper missing", () => new ssh.HelperMissingError(), "helper_missing"],
    ["anything else", () => new Error("weird"), "unknown"],
  ])("%s → error %s", async (_name, err, code) => {
    const { server } = await setup();
    probe.mockRejectedValue(err());
    await recheckServers();
    expect(await row(server.id)).toMatchObject({ status: "error", statusMessage: code });
  });

  it("an outdated helper → error helper_outdated, keeping what it reported", async () => {
    const { server } = await setup();
    probe.mockRejectedValue(new ssh.HelperOutdatedError(info({ helperVersion: 0, node: "v20.0.0" })));
    await recheckServers();
    const r = await row(server.id);
    expect(r).toMatchObject({ status: "error", statusMessage: "helper_outdated" });
    expect(r.info).toMatchObject({ helperVersion: 0, node: "v20.0.0" });
  });

  it("a server set up for another domain → error server_domain_mismatch", async () => {
    const { server } = await setup();
    probe.mockResolvedValue(info({ baseDomain: "other.example.com" }));
    await recheckServers();
    expect(await row(server.id)).toMatchObject({ status: "error", statusMessage: "server_domain_mismatch" });
  });

  it("skips pending servers, servers without a pinned key and servers checked within the hour", async () => {
    const { server: pending } = await setup({ status: "pending" });
    const { server: unpinned } = await setup({ hostKey: null, hostKeyAlgo: null });
    const { server: fresh } = await setup({ lastCheckedAt: new Date(Date.now() - 10 * 60_000) });
    probe.mockResolvedValue(info());
    const out = await recheckServers();
    const ids = out.map((o) => o.serverId);
    expect(ids).not.toContain(pending.id);
    expect(ids).not.toContain(unpinned.id);
    expect(ids).not.toContain(fresh.id);
    const probed = probe.mock.calls.map((c) => c[0].host);
    for (const s of [pending, unpinned, fresh]) expect(probed).not.toContain(s.host);
  });

  it("an Owner re-verifying during the probe wins: the stale result is dropped and nobody is notified", async () => {
    const { ws, server } = await setup();
    probe.mockImplementation(async () => {
      // meanwhile the Owner pinned a new key (verify) — the old probe must not overwrite it
      await db.update(servers).set({ hostKey: Buffer.alloc(51, 9).toString("base64") }).where(eq(servers.id, server.id));
      throw new ssh.HostKeyMismatchError();
    });
    const out = await recheckServers();
    expect(out.map((o) => o.serverId)).not.toContain(server.id);
    expect(await row(server.id)).toMatchObject({ status: "ready" });
    expect(notifications().filter((n) => n.workspaceId === ws.id)).toEqual([]);
    expect(serverEvents(server.id)).toEqual([]);
  });

  it("a workspace without an SSH key → error ssh_auth_failed, without probing", async () => {
    const { ws, server } = await setup();
    await db.delete(credentials).where(eq(credentials.workspaceId, ws.id));
    await recheckServers();
    expect(await row(server.id)).toMatchObject({ status: "error", statusMessage: "ssh_auth_failed" });
    expect(probe.mock.calls.map((c) => c[0].host)).not.toContain(server.host);
  });
});

/** The public key blob inside an unencrypted OpenSSH private key: magic, cipher, kdf, kdf options, count, then it. */
function embeddedPublicBlob(pem: string): string {
  const body = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  let p = "openssh-key-v1\0".length;
  const str = () => {
    const n = body.readUInt32BE(p);
    const v = body.subarray(p + 4, p + 4 + n);
    p += 4 + n;
    return v;
  };
  str();
  str();
  str();
  p += 4;
  return str().toString("base64");
}

describe("workspace SSH key", () => {
  it("is created once, also under concurrent first use, and only the public half is returned", async () => {
    const ws = await makeWorkspace();
    const keys = await Promise.all(Array.from({ length: 5 }, () => getOrCreateWorkspaceSshKey(db, ws.id, ws.slug)));
    expect(new Set(keys.map((k) => k.fingerprint)).size).toBe(1);
    expect(keys[0]!.publicKey).toMatch(new RegExp(`^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ wfos-${ws.slug}$`));
    expect(keys[0]).not.toHaveProperty("privateKey");
    expect(JSON.stringify(keys[0])).not.toContain("PRIVATE");
    const rows = (await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id))).filter((c) => c.kind === "ssh");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config).not.toHaveProperty("privateKey");
    expect(rows[0]!.secretEnc).not.toContain("PRIVATE"); // stored encrypted
    const priv = await workspaceSshPrivateKey(db, ws.id);
    expect(priv).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    // the stored private key belongs to the returned public key (the public blob embedded in the openssh-key-v1 body)
    expect(embeddedPublicBlob(priv!)).toBe(keys[0]!.publicKey.split(" ")[1]);
    // later calls return the same key
    expect((await getOrCreateWorkspaceSshKey(db, ws.id, ws.slug)).fingerprint).toBe(keys[0]!.fingerprint);
  });

  it("is per workspace", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const ka = await getOrCreateWorkspaceSshKey(db, a.id, a.slug);
    const kb = await getOrCreateWorkspaceSshKey(db, b.id, b.slug);
    expect(ka.fingerprint).not.toBe(kb.fingerprint);
    expect(await workspaceSshPrivateKey(db, randomUUID())).toBeNull();
  });
});
