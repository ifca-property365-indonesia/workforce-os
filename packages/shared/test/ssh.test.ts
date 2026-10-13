import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ssh2, { type Connection, type ServerChannel } from "ssh2";
import { WFOS_HELPER_VERSION } from "../src/index";
import { SsrfBlockedError, type Resolver } from "../src/netguard";
import {
  generateWorkspaceKey,
  HelperMissingError,
  HelperOutdatedError,
  HostKeyMismatchError,
  HostNotAllowedError,
  probeServer,
  resolveServerHost,
  scanHostKey,
  sftpPut,
  SshAuthError,
  SshConnectError,
  sshErrorCode,
  sshExec,
  sshFingerprint,
  sshKeyBlobAlgo,
  SshTimeoutError,
  type SshTarget,
} from "../src/ssh";

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

const blobOf = (publicKeyLine: string) => Buffer.from(publicKeyLine.split(" ")[1]!, "base64");
const hasSshKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (e) {
    // ssh-keygen -? exits non-zero but exists
    return (e as { code?: string }).code !== "ENOENT";
  }
})();

describe("generateWorkspaceKey", () => {
  const k = generateWorkspaceKey("wfos-acme");

  it("returns an OpenSSH public key line with the comment", () => {
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+=* wfos-acme$/);
    expect(blobOf(k.publicKey)).toHaveLength(51); // string "ssh-ed25519" (4+11) + string pub (4+32)
    expect(sshKeyBlobAlgo(blobOf(k.publicKey))).toBe("ssh-ed25519");
  });

  it("returns an unencrypted OpenSSH private key that ssh2 parses back to the same public key", () => {
    expect(k.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/);
    const parsed = utils.parseKey(k.privateKey);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe("ssh-ed25519");
    expect(parsed.comment).toBe("wfos-acme");
    expect(parsed.getPublicSSH().equals(blobOf(k.publicKey))).toBe(true);
    // the private key really signs for the public key
    const data = Buffer.from("challenge");
    const sig = parsed.sign(data);
    expect(sig).toBeInstanceOf(Buffer);
    expect(parsed.verify(data, sig as Buffer)).toBe(true);
  });

  it("fingerprints like ssh-keygen -lf (SHA256 of the blob, base64 without padding)", () => {
    const expected = "SHA256:" + createHash("sha256").update(blobOf(k.publicKey)).digest("base64").replace(/=+$/, "");
    expect(k.fingerprint).toBe(expected);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(sshFingerprint(blobOf(k.publicKey).toString("base64"))).toBe(expected);
  });

  it("drops characters that do not belong in an authorized_keys comment", () => {
    expect(generateWorkspaceKey("wfos-a b\nc").publicKey).toMatch(/ wfos-abc$/);
    expect(generateWorkspaceKey("").publicKey.split(" ")).toHaveLength(2);
  });

  it("makes a new key every time", () => {
    expect(generateWorkspaceKey("x").fingerprint).not.toBe(generateWorkspaceKey("x").fingerprint);
  });

  it.runIf(hasSshKeygen)("is accepted by OpenSSH's ssh-keygen with the same fingerprint", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wfos-ssh-test-"));
    writeFileSync(path.join(dir, "id"), k.privateKey, { mode: 0o600 });
    writeFileSync(path.join(dir, "id.pub"), k.publicKey + "\n");
    expect(execFileSync("ssh-keygen", ["-y", "-f", path.join(dir, "id")], { encoding: "utf8" }).trim()).toBe(k.publicKey);
    expect(execFileSync("ssh-keygen", ["-lf", path.join(dir, "id.pub")], { encoding: "utf8" })).toContain(k.fingerprint);
  });
});

describe("sshKeyBlobAlgo", () => {
  it("rejects malformed blobs", () => {
    expect(sshKeyBlobAlgo(Buffer.alloc(2))).toBeNull();
    expect(sshKeyBlobAlgo(Buffer.from([0, 0, 0, 200, 1, 2]))).toBeNull();
    expect(sshKeyBlobAlgo(Buffer.from([0, 0, 0, 3, 0x41, 0x20, 0x42]))).toBeNull();
  });
});

describe("resolveServerHost", () => {
  const fixed = (...addresses: string[]): Resolver => async () => addresses.map((address) => ({ address, family: net.isIP(address) }));

  it("returns public IP literals as they are", async () => {
    await expect(resolveServerHost("8.8.8.8")).resolves.toBe("8.8.8.8");
    await expect(resolveServerHost("[2606:4700:4700::1111]")).resolves.toBe("2606:4700:4700::1111");
  });

  it.each(["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.5", "169.254.169.254", "100.64.1.1", "fd00::1", "fe80::1", "::1", "::ffff:127.0.0.1"])(
    "refuses private address %s by default and allows it with allowPrivate",
    async (ip) => {
      await expect(resolveServerHost(ip)).rejects.toBeInstanceOf(HostNotAllowedError);
      await expect(resolveServerHost(ip, { allowPrivate: true })).resolves.toBe(ip.toLowerCase());
    },
  );

  it.each(["0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1", "::", "ff02::1", "::ffff:0.0.0.0"])(
    "always refuses %s, even with allowPrivate",
    async (ip) => {
      await expect(resolveServerHost(ip, { allowPrivate: true })).rejects.toBeInstanceOf(HostNotAllowedError);
    },
  );

  it("resolves a hostname once and returns the first address (DNS pinning)", async () => {
    let calls = 0;
    const resolve: Resolver = async (h) => {
      calls++;
      expect(h).toBe("apps.example.com");
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ];
    };
    await expect(resolveServerHost("Apps.Example.com", { resolve })).resolves.toBe("93.184.216.34");
    expect(calls).toBe(1);
  });

  it("refuses a hostname when any address is private (no rebinding through a mixed answer)", async () => {
    await expect(resolveServerHost("evil.example.com", { resolve: fixed("93.184.216.34", "127.0.0.1") })).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(resolveServerHost("evil.example.com", { resolve: fixed("93.184.216.34", "127.0.0.1"), allowPrivate: true })).resolves.toBe("93.184.216.34");
    await expect(resolveServerHost("localhost", { resolve: fixed("127.0.0.1") })).rejects.toBeInstanceOf(HostNotAllowedError);
  });

  it("maps DNS failures to ssh_unreachable", async () => {
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(resolveServerHost("nope.example.com", { resolve: failing })).rejects.toBeInstanceOf(SshConnectError);
    await expect(resolveServerHost("empty.example.com", { resolve: fixed() })).rejects.toBeInstanceOf(SshConnectError);
  });

  it.each(["", "  ", "exa mple.com", "-bad.com", "a..b", "fe80::1%eth0", "http://x.com", "x.com/path", "a".repeat(64) + ".com"])("refuses invalid host %j", async (h) => {
    await expect(resolveServerHost(h, { resolve: fixed("93.184.216.34") })).rejects.toBeInstanceOf(HostNotAllowedError);
  });
});

describe("sshErrorCode", () => {
  it("maps the typed errors and raw ssh2 errors", () => {
    expect(sshErrorCode(new HostKeyMismatchError())).toBe("host_key_mismatch");
    expect(sshErrorCode(new SshAuthError())).toBe("ssh_auth_failed");
    expect(sshErrorCode(new SshConnectError("x"))).toBe("ssh_unreachable");
    expect(sshErrorCode(new SshTimeoutError("x"))).toBe("ssh_unreachable");
    expect(sshErrorCode(new HostNotAllowedError("x"))).toBe("server_host_not_allowed");
    expect(sshErrorCode(new SsrfBlockedError("x"))).toBe("server_host_not_allowed");
    expect(sshErrorCode(new HelperMissingError())).toBe("helper_missing");
    expect(sshErrorCode(new HelperOutdatedError({ helperVersion: 0 } as never))).toBe("helper_outdated");
    expect(sshErrorCode(Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" }))).toBe("ssh_auth_failed");
    expect(sshErrorCode(Object.assign(new Error("Timed out"), { level: "client-timeout" }))).toBe("ssh_unreachable");
    expect(sshErrorCode(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe("unknown");
    expect(sshErrorCode(new Error("x"))).toBe("unknown");
    expect(sshErrorCode("x")).toBe("unknown");
    expect(sshErrorCode(null)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// End to end against an in-process ssh2 server on 127.0.0.1 (nothing leaves this machine)
// ---------------------------------------------------------------------------

const hostKey = generateWorkspaceKey("test-host");
const otherHostKey = generateWorkspaceKey("other-host");
const clientKey = generateWorkspaceKey("wfos-test");
const strangerKey = generateWorkspaceKey("stranger");
const clientBlob = blobOf(clientKey.publicKey);
const clientPub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), clientBlob.subarray(19)]), format: "der", type: "spki" });

let helperReply: { stdout?: string; stderr?: string; code: number } = { code: 0 };
const files = new Map<string, Buffer>();
const sessions: { agentForward: boolean; methods: string[] }[] = [];
let server: InstanceType<typeof Server>;
let port = 0;

function runCommand(cmd: string, stream: ServerChannel): void {
  const finish = (code: number) => {
    stream.exit(code);
    stream.end();
  };
  if (cmd === "echo hello") {
    stream.write("hello\n");
    return finish(0);
  }
  if (cmd === "fail") {
    stream.stderr.write("boom\n");
    return finish(3);
  }
  if (cmd === "cat") {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      stream.write(Buffer.concat(chunks));
      finish(0);
    });
    return;
  }
  if (cmd === "big") {
    stream.write(Buffer.alloc(300_000, 0x61));
    stream.stderr.write(Buffer.alloc(10, 0x62));
    return finish(0);
  }
  if (cmd === "utf8") {
    const b = Buffer.from("héllo wörld ✓");
    stream.write(b.subarray(0, 2));
    setTimeout(() => {
      stream.write(b.subarray(2));
      finish(0);
    }, 20);
    return;
  }
  if (cmd === "sleep") return; // never finishes
  if (cmd === "sudo -n /usr/local/sbin/wfos-app-helper info") {
    if (helperReply.stdout) stream.write(helperReply.stdout);
    if (helperReply.stderr) stream.stderr.write(helperReply.stderr);
    return finish(helperReply.code);
  }
  stream.stderr.write(`unknown test command ${cmd}\n`);
  finish(127);
}

function serveSftp(sftp: ssh2.SFTPWrapper): void {
  const handles = new Map<number, string>();
  let next = 0;
  sftp.on("OPEN", (reqid, filename) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(++next);
    handles.set(next, filename);
    files.set(filename, Buffer.alloc(0));
    sftp.handle(reqid, h);
  });
  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const name = handles.get(handle.readUInt32BE(0));
    if (!name) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const cur = files.get(name)!;
    const out = Buffer.alloc(Math.max(cur.length, offset + data.length));
    cur.copy(out);
    data.copy(out, offset);
    files.set(name, out);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("CLOSE", (reqid, handle) => {
    handles.delete(handle.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("REMOVE", (reqid, p) => sftp.status(reqid, files.delete(p) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE));
  sftp.on("RENAME", (reqid, from, to) => {
    if (!files.has(from) || files.has(to)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    files.set(to, files.get(from)!);
    files.delete(from);
    sftp.status(reqid, STATUS_CODE.OK);
  });
}

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.privateKey] }, (client: Connection) => {
    const seen = { agentForward: false, methods: [] as string[] };
    sessions.push(seen);
    client.on("authentication", (ctx) => {
      seen.methods.push(ctx.method);
      if (ctx.method !== "publickey" || ctx.username !== "wfos-apps" || ctx.key.algo !== "ssh-ed25519" || !ctx.key.data.equals(clientBlob)) return ctx.reject(["publickey"]);
      if (!ctx.signature) return ctx.accept(); // key check before signing
      if (cryptoVerify(null, ctx.blob!, clientPub, ctx.signature)) return ctx.accept();
      ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("auth-agent", (acceptAgent) => {
          seen.agentForward = true;
          acceptAgent();
        });
        session.on("exec", (acceptExec, _reject, info) => runCommand(info.command, acceptExec()));
        session.on("sftp", (acceptSftp) => serveSftp(acceptSftp()));
      });
    });
    client.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const target = (over: Partial<SshTarget> = {}): SshTarget => ({
  host: "127.0.0.1",
  port,
  username: "wfos-apps",
  privateKey: clientKey.privateKey,
  hostKeyAlgo: "ssh-ed25519",
  hostKey: blobOf(hostKey.publicKey).toString("base64"),
  allowPrivate: true,
  ...over,
});

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

describe("scanHostKey", () => {
  it("returns the server's ed25519 host key and its fingerprint without authenticating", async () => {
    const before = sessions.length;
    const r = await scanHostKey({ host: "127.0.0.1", port, allowPrivate: true });
    expect(r).toEqual({ algo: "ssh-ed25519", key: blobOf(hostKey.publicKey).toString("base64"), fingerprint: hostKey.fingerprint });
    expect(sessions.slice(before).every((s) => s.methods.length === 0)).toBe(true);
  });

  it("refuses a private host without allowPrivate", async () => {
    await expect(scanHostKey({ host: "127.0.0.1", port })).rejects.toBeInstanceOf(HostNotAllowedError);
  });

  it("reports an unreachable server", async () => {
    await expect(scanHostKey({ host: "127.0.0.1", port: await closedPort(), allowPrivate: true, timeoutMs: 3000 })).rejects.toBeInstanceOf(SshConnectError);
  });
});

describe("sshExec", () => {
  it("runs a command with the pinned host key and the workspace key", async () => {
    await expect(sshExec(target(), "echo hello")).resolves.toEqual({ code: 0, stdout: "hello\n", stderr: "", truncated: false });
  });

  it("never asks for agent forwarding and only uses public-key auth", async () => {
    const before = sessions.length;
    await sshExec(target(), "echo hello");
    const mine = sessions.slice(before);
    expect(mine.some((s) => s.agentForward)).toBe(false);
    expect(new Set(mine.flatMap((s) => s.methods))).toEqual(new Set(["publickey"]));
  });

  it("returns the exit code and stderr of a failing command", async () => {
    await expect(sshExec(target(), "fail")).resolves.toMatchObject({ code: 3, stdout: "", stderr: "boom\n" });
  });

  it("writes stdin and closes it", async () => {
    await expect(sshExec(target(), "cat", { stdin: "line1\nline2" })).resolves.toMatchObject({ code: 0, stdout: "line1\nline2" });
    await expect(sshExec(target(), "cat", { stdin: Buffer.from([0x68, 0x69]) })).resolves.toMatchObject({ stdout: "hi" });
  });

  it("caps output and says so; onData still sees every chunk", async () => {
    let seen = 0;
    const r = await sshExec(target(), "big", { maxOutputBytes: 1000, onData: (c) => (seen += c.length) });
    expect(r.truncated).toBe(true);
    expect(r.stdout).toHaveLength(1000);
    expect(r.stderr).toBe("bbbbbbbbbb");
    expect(seen).toBe(300_010);
  });

  it("decodes UTF-8 split across chunks", async () => {
    const chunks: string[] = [];
    const r = await sshExec(target(), "utf8", { onData: (c) => chunks.push(c) });
    expect(r.stdout).toBe("héllo wörld ✓");
    expect(chunks.join("")).toBe("héllo wörld ✓");
  });

  it("times out a command that does not finish", async () => {
    await expect(sshExec(target(), "sleep", { timeoutMs: 300 })).rejects.toBeInstanceOf(SshTimeoutError);
  });

  it("refuses a server whose host key is not the pinned one", async () => {
    const err = await sshExec(target({ hostKey: blobOf(otherHostKey.publicKey).toString("base64") }), "echo hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostKeyMismatchError);
    expect(sshErrorCode(err)).toBe("host_key_mismatch");
  });

  it("refuses a server that no longer offers the pinned key type", async () => {
    // a pinned ECDSA key: the server only has ed25519 now
    const fake = Buffer.concat([Buffer.from([0, 0, 0, 19]), Buffer.from("ecdsa-sha2-nistp256"), Buffer.alloc(40, 1)]);
    await expect(sshExec(target({ hostKeyAlgo: "ecdsa-sha2-nistp256", hostKey: fake.toString("base64") }), "echo hello")).rejects.toBeInstanceOf(HostKeyMismatchError);
  });

  it("refuses to connect without a valid pinned key", async () => {
    await expect(sshExec(target({ hostKey: "" }), "echo hello")).rejects.toBeInstanceOf(HostKeyMismatchError);
    await expect(sshExec(target({ hostKeyAlgo: "ssh-rsa" }), "echo hello")).rejects.toBeInstanceOf(HostKeyMismatchError);
  });

  it("reports a key the server does not accept as ssh_auth_failed", async () => {
    await expect(sshExec(target({ privateKey: strangerKey.privateKey }), "echo hello")).rejects.toBeInstanceOf(SshAuthError);
    await expect(sshExec(target({ username: "root" }), "echo hello")).rejects.toBeInstanceOf(SshAuthError);
  });

  it("reports an unreachable server", async () => {
    await expect(sshExec(target({ port: await closedPort() }), "echo hello")).rejects.toBeInstanceOf(SshConnectError);
  });

  it("refuses a private host without allowPrivate", async () => {
    await expect(sshExec(target({ allowPrivate: false }), "echo hello")).rejects.toBeInstanceOf(HostNotAllowedError);
  });

  it("never echoes an unparseable private key in the error", async () => {
    const err = (await sshExec(target({ privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecretsecret\n-----END OPENSSH PRIVATE KEY-----\n" }), "x").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("secretsecret");
  });
});

describe("sftpPut", () => {
  it("uploads to a temporary name and moves it into place", async () => {
    files.set("/srv/app/app.env", Buffer.from("old"));
    await sftpPut(target(), "/srv/app/app.env", Buffer.from("PORT=4100\n"), { mode: 0o600 });
    expect(files.get("/srv/app/app.env")?.toString()).toBe("PORT=4100\n");
    expect([...files.keys()].filter((k) => k.includes(".wfos-tmp-"))).toEqual([]);
  });

  it("uploads a stream", async () => {
    await sftpPut(target(), "/srv/app/release.tar", Readable.from([Buffer.from("abc"), Buffer.from("def")]));
    expect(files.get("/srv/app/release.tar")?.toString()).toBe("abcdef");
  });

  it("rejects invalid remote paths", async () => {
    await expect(sftpPut(target(), "/srv/app/\nx", Buffer.from("x"))).rejects.toThrow("Invalid remote path");
    await expect(sftpPut(target(), "", Buffer.from("x"))).rejects.toThrow("Invalid remote path");
  });
});

describe("probeServer", () => {
  const info = { helperVersion: WFOS_HELPER_VERSION, os: "Ubuntu 24.04", node: "v24.1.0", pnpm: "10.33.0", nginx: true, certbot: true, postgresPort: 5433, diskFreeMb: 20000, memTotalMb: 7800, memAvailableMb: 4000, baseDomain: "preview.example.com", systemd: 259, firewall: true, appsRoot: "/srv/wfos-apps" };

  it("parses the helper's info line", async () => {
    helperReply = { code: 0, stdout: JSON.stringify(info) + "\n" };
    await expect(probeServer(target())).resolves.toEqual(info);
  });

  it.each([
    [1, "sudo: a password is required\n"],
    [1, "sudo: /usr/local/sbin/wfos-app-helper: command not found\n"],
    [1, "Sorry, user wfos-apps is not allowed to execute '/usr/local/sbin/wfos-app-helper info' as root.\n"],
    [127, "bash: sudo: command not found\n"],
    [1, "sudo: unable to execute /usr/local/sbin/wfos-app-helper: No such file or directory\n"],
  ])("maps exit %i %j to helper_missing", async (code, stderr) => {
    helperReply = { code, stderr };
    const err = await probeServer(target()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelperMissingError);
    expect(sshErrorCode(err)).toBe("helper_missing");
  });

  it("throws helper_outdated with the info when the helper is older", async () => {
    helperReply = { code: 0, stdout: JSON.stringify({ ...info, helperVersion: WFOS_HELPER_VERSION - 1 }) };
    const err = (await probeServer(target()).catch((e: unknown) => e)) as HelperOutdatedError;
    expect(err).toBeInstanceOf(HelperOutdatedError);
    expect(err.info.baseDomain).toBe("preview.example.com");
    expect(sshErrorCode(err)).toBe("helper_outdated");
  });

  it("rejects output that is not the info JSON", async () => {
    helperReply = { code: 0, stdout: "hello\n" };
    await expect(probeServer(target())).rejects.toThrow("did not print JSON");
    helperReply = { code: 0, stdout: JSON.stringify({ helperVersion: "one" }) };
    await expect(probeServer(target())).rejects.toThrow("unexpected shape");
    helperReply = { code: 2, stderr: "wfos-app-helper: disk exploded\n" };
    const err = await probeServer(target()).catch((e: unknown) => e);
    expect(sshErrorCode(err)).toBe("unknown");
  });
});
