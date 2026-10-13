import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig, type ServerHostKeyAlgorithm, type SFTPWrapper } from "ssh2";
import { serverInfoSchema, WFOS_HELPER_VERSION, type ServerInfo } from "./index";
import { isBlockedAddress, SsrfBlockedError, type Resolver } from "./netguard";
import { sshFingerprint, sshKeyBlobAlgo } from "./ssh-keys";

export { generateWorkspaceKey, sshFingerprint, sshKeyBlobAlgo } from "./ssh-keys";

// ---------------------------------------------------------------------------
// SSH to the servers a workspace registers (app factory). Server-only: it holds private keys in memory.
// Every connection: DNS resolved once and the socket dialled to that IP, the host key compared byte for byte with
// the pinned one, public-key auth only (no password, no keyboard-interactive, no agent, no forwarding), timeouts on
// the handshake and on every command.
// ---------------------------------------------------------------------------

export const SSH_ERROR_CODES = ["host_key_mismatch", "ssh_auth_failed", "ssh_unreachable", "server_host_not_allowed", "helper_missing", "helper_outdated", "unknown"] as const;
export type SshErrorCode = (typeof SSH_ERROR_CODES)[number];

/** The server presented a different host key than the one an Owner pinned (or no longer offers that key type). */
export class HostKeyMismatchError extends Error {
  readonly code = "host_key_mismatch" as const;
  constructor(message = "The server's host key does not match the pinned key") {
    super(message);
    this.name = "HostKeyMismatchError";
  }
}

/** The server refused our key: not installed in authorized_keys, or the wrong user. */
export class SshAuthError extends Error {
  readonly code = "ssh_auth_failed" as const;
  constructor(message = "The server refused the workspace SSH key") {
    super(message);
    this.name = "SshAuthError";
  }
}

/** The server could not be reached or the connection broke: DNS, refused, timeout, handshake failure. */
export class SshConnectError extends Error {
  readonly code = "ssh_unreachable" as const;
  constructor(message: string) {
    super(message);
    this.name = "SshConnectError";
  }
}

/** A command ran longer than its timeout (the connection is closed, the remote process gets SIGHUP). */
export class SshTimeoutError extends SshConnectError {
  constructor(message: string) {
    super(message);
    this.name = "SshTimeoutError";
  }
}

/** The host resolves to an address servers may not use (private, loopback… unless APP_SERVERS_ALLOW_PRIVATE). */
export class HostNotAllowedError extends Error {
  readonly code = "server_host_not_allowed" as const;
  constructor(message: string) {
    super(message);
    this.name = "HostNotAllowedError";
  }
}

/** sudo could not run /usr/local/sbin/wfos-app-helper: prepare.sh was not run (or not to the end) on that server. */
export class HelperMissingError extends Error {
  readonly code = "helper_missing" as const;
  constructor(message = "wfos-app-helper is not installed on the server (run prepare.sh)") {
    super(message);
    this.name = "HelperMissingError";
  }
}

/** The helper is older than WFOS_HELPER_VERSION; `info` is what it reported (re-run prepare.sh to update). */
export class HelperOutdatedError extends Error {
  readonly code = "helper_outdated" as const;
  constructor(readonly info: ServerInfo) {
    super(`wfos-app-helper ${info.helperVersion} is older than the required version ${WFOS_HELPER_VERSION} (re-run prepare.sh)`);
    this.name = "HelperOutdatedError";
  }
}

/** The error code an API or the worker stores / shows for an error from this module. */
export function sshErrorCode(e: unknown): SshErrorCode {
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (SSH_ERROR_CODES as readonly string[]).includes(code)) return code as SshErrorCode;
    if (e instanceof SsrfBlockedError) return "server_host_not_allowed";
    // raw ssh2 errors (should not escape this module, but map them anyway)
    const level = (e as { level?: unknown }).level;
    if (level === "client-authentication") return "ssh_auth_failed";
    if (level === "client-timeout" || level === "client-socket" || level === "client-dns") return "ssh_unreachable";
  }
  return "unknown";
}

/** Instance policy: may servers live on private / loopback addresses? (APP_SERVERS_ALLOW_PRIVATE=true) */
export function appServersAllowPrivate(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APP_SERVERS_ALLOW_PRIVATE === "true";
}

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

// Never dialled, even with allowPrivate: "this network"/unspecified, multicast, reserved + broadcast.
// (One list: Node's BlockList matches IPv4-mapped IPv6 addresses against the IPv4 rules.)
const never = new BlockList();
never.addSubnet("0.0.0.0", 8, "ipv4");
never.addSubnet("224.0.0.0", 4, "ipv4");
never.addSubnet("240.0.0.0", 4, "ipv4");
never.addAddress("::", "ipv6");
never.addSubnet("ff00::", 8, "ipv6");

const HOSTNAME_RE = /^(?=.{1,253}\.?$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/;

/** Throws HostNotAllowedError when `ip` may not be dialled under this policy. */
function checkAddress(ip: string, allowPrivate: boolean, host: string): void {
  const family = isIP(ip);
  if (!family || never.check(ip, family === 4 ? "ipv4" : "ipv6")) throw new HostNotAllowedError(`${host} (${ip}) is not a usable address`);
  if (!allowPrivate && isBlockedAddress(ip)) throw new HostNotAllowedError(`${host} (${ip}) is a private or reserved address; servers must be public`);
}

const defaultResolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The IP address to dial for a server's `host` (an IP literal or a hostname). A hostname is resolved once; every
 * address it resolves to must be allowed (so a mixed answer cannot be used to rebind), and the first is returned:
 * callers connect to that IP, never to the name again. Private, loopback, link-local, CGNAT and ULA addresses need
 * `allowPrivate`; unspecified, multicast and broadcast addresses are always refused.
 */
export async function resolveServerHost(host: string, opts: { allowPrivate?: boolean; resolve?: Resolver } = {}): Promise<string> {
  const allowPrivate = opts.allowPrivate === true;
  const h = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!h || h.includes("%")) throw new HostNotAllowedError(`Invalid host ${JSON.stringify(host)}`);
  if (isIP(h)) {
    checkAddress(h, allowPrivate, h);
    return h;
  }
  if (!HOSTNAME_RE.test(h)) throw new HostNotAllowedError(`Invalid host ${JSON.stringify(host)}`);
  let records: { address: string; family: number }[];
  try {
    records = await (opts.resolve ?? defaultResolve)(h);
  } catch (e) {
    throw new SshConnectError(`DNS lookup failed for ${h}: ${(e as Error).message}`);
  }
  if (!records.length) throw new SshConnectError(`DNS lookup returned no address for ${h}`);
  for (const r of records) checkAddress(r.address, allowPrivate, h);
  return records[0]!.address;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 15_000;
const SCAN_ALGOS: ServerHostKeyAlgorithm[] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"];

/** Negotiable host key algorithms for a pinned key's type (an RSA key is "ssh-rsa" in the blob, signed with SHA-2). */
function algosFor(keyType: string): ServerHostKeyAlgorithm[] {
  if (keyType === "ssh-rsa") return ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"];
  if ((SCAN_ALGOS as string[]).includes(keyType)) return [keyType as ServerHostKeyAlgorithm];
  throw new HostKeyMismatchError(`Unsupported pinned host key type ${keyType}`);
}

/** A connection-phase ssh2 error as one of our typed errors. */
function connectError(e: unknown, mismatch: boolean): Error {
  if (mismatch) return new HostKeyMismatchError();
  const err = e as Error & { level?: string };
  if (err?.level === "client-authentication") return new SshAuthError();
  // the server no longer offers the pinned key's type: from our side that is a different host key
  if (err?.level === "handshake" && /no matching host key format/i.test(err.message)) return new HostKeyMismatchError("The server no longer offers the pinned host key type");
  if (err?.level === "client-timeout") return new SshConnectError("Timed out connecting to the server");
  return new SshConnectError(err?.message || "SSH connection failed");
}

/** End the session; destroy the socket if a graceful end does not finish soon. */
function closeClient(client: Client): void {
  try {
    client.end();
  } catch {
    /* already closed */
  }
  setTimeout(() => client.destroy(), 2_000).unref();
}

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  /** OpenSSH private key (decrypted from the workspace's "ssh" credential); never logged */
  privateKey: string;
  /** pinned host key: type as in the blob (e.g. "ssh-ed25519") and the base64 blob */
  hostKeyAlgo: string;
  hostKey: string;
  allowPrivate?: boolean;
}

/** An authenticated connection to a server whose host key is exactly the pinned one. */
async function connectPinned(t: SshTarget): Promise<Client> {
  const pinned = Buffer.from(t.hostKey ?? "", "base64");
  if (!t.hostKey || !t.hostKeyAlgo || sshKeyBlobAlgo(pinned) !== t.hostKeyAlgo) throw new HostKeyMismatchError("The server has no valid pinned host key");
  const algos = algosFor(t.hostKeyAlgo);
  const ip = await resolveServerHost(t.host, { allowPrivate: t.allowPrivate });
  const client = new Client();
  let mismatch = false;
  const cfg: ConnectConfig = {
    host: ip,
    port: t.port,
    username: t.username,
    privateKey: t.privateKey,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    algorithms: { serverHostKey: algos },
    hostVerifier: (key: Buffer) => {
      if (key.equals(pinned)) return true;
      mismatch = true;
      return false;
    },
    authHandler: ["publickey"],
    agentForward: false,
    tryKeyboard: false,
  };
  return new Promise<Client>((resolve, reject) => {
    const onError = (e: unknown) => {
      client.destroy();
      reject(connectError(e, mismatch));
    };
    client.on("error", onError);
    client.once("ready", () => {
      // from here each operation listens for errors itself; this keeps a late error from ever being unhandled
      client.off("error", onError);
      client.on("error", () => {});
      resolve(client);
    });
    try {
      client.connect(cfg);
    } catch (e) {
      // ssh2 throws synchronously on an unparseable private key: never echo the key itself
      client.off("error", onError);
      reject(new Error(`SSH connect failed: ${(e as Error).message.replace(/-----BEGIN[\s\S]*$/, "")}`));
    }
  });
}

/**
 * The server's host key, without authenticating: the handshake is stopped right after the key is seen. Prefers an
 * ssh-ed25519 key. `key` is the base64 blob, `algo` its type, `fingerprint` as `ssh-keygen -lf` prints it.
 * Nothing is trusted here: the Owner compares the fingerprint on the server before it is pinned.
 */
export async function scanHostKey(t: { host: string; port: number; timeoutMs?: number; allowPrivate?: boolean }): Promise<{ algo: string; key: string; fingerprint: string }> {
  const ip = await resolveServerHost(t.host, { allowPrivate: t.allowPrivate });
  const client = new Client();
  let seen: Buffer | null = null;
  try {
    return await new Promise((resolve, reject) => {
      const done = (e?: unknown) => {
        if (seen) {
          const algo = sshKeyBlobAlgo(seen);
          if (!algo) return reject(new SshConnectError("The server sent a malformed host key"));
          return resolve({ algo, key: seen.toString("base64"), fingerprint: sshFingerprint(seen) });
        }
        reject(connectError(e ?? new Error("Connection closed before the host key was received"), false));
      };
      client.on("error", (e) => done(e));
      client.on("close", () => done());
      // never expected: the verifier below always stops the handshake
      client.on("ready", () => done());
      client.connect({
        host: ip,
        port: t.port,
        username: "wfos-scan",
        readyTimeout: t.timeoutMs ?? CONNECT_TIMEOUT_MS,
        algorithms: { serverHostKey: SCAN_ALGOS },
        hostVerifier: (key: Buffer) => {
          seen = Buffer.from(key);
          return false;
        },
        authHandler: [],
        agentForward: false,
        tryKeyboard: false,
      });
    });
  } finally {
    client.destroy();
  }
}

export interface SshExecResult {
  /** exit status; null when the command ended without one (killed by a signal) */
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout or stderr went over maxOutputBytes and was cut */
  truncated: boolean;
}

/**
 * Run one command on a server (pinned host key, workspace key). `stdin` is written then closed; `onData` gets the
 * decoded stdout and stderr chunks as they arrive (all of them, also beyond the cap); stdout and stderr are each
 * kept up to `maxOutputBytes` (default 1 MB). Over `timeoutMs` (default 60 s) the connection is closed and
 * SshTimeoutError thrown. The connection is always closed afterwards.
 */
export async function sshExec(
  t: SshTarget,
  command: string,
  o: { stdin?: string | Buffer; timeoutMs?: number; onData?: (chunk: string) => void; maxOutputBytes?: number } = {},
): Promise<SshExecResult> {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const max = o.maxOutputBytes ?? 1_000_000;
  const client = await connectPinned(t);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<SshExecResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new SshTimeoutError(`Command timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      client.on("error", (e) => reject(connectError(e, false)));
      client.on("close", () => reject(new SshConnectError("The connection closed before the command finished")));
      client.exec(command, (err, stream: ClientChannel) => {
        if (err) return reject(new SshConnectError(`Could not start the command: ${err.message}`));
        const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
        const size = { stdout: 0, stderr: 0 };
        let truncated = false;
        let code: number | null = null;
        const keep = (which: "stdout" | "stderr", decoder: StringDecoder) => (chunk: Buffer) => {
          if (o.onData) {
            const s = decoder.write(chunk);
            if (s) o.onData(s);
          }
          const room = max - size[which];
          if (room <= 0) {
            truncated = true;
            return;
          }
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          if (part.length < chunk.length) truncated = true;
          out[which].push(Buffer.from(part));
          size[which] += part.length;
        };
        stream.on("data", keep("stdout", new StringDecoder("utf8")));
        stream.stderr.on("data", keep("stderr", new StringDecoder("utf8")));
        stream.on("exit", (c: number | null) => {
          code = typeof c === "number" ? c : null;
        });
        stream.on("error", (e: Error) => reject(new SshConnectError(e.message)));
        stream.on("close", () =>
          resolve({ code, stdout: Buffer.concat(out.stdout).toString("utf8"), stderr: Buffer.concat(out.stderr).toString("utf8"), truncated }),
        );
        if (o.stdin !== undefined) stream.end(o.stdin);
        else stream.end();
      });
    });
  } finally {
    clearTimeout(timer);
    closeClient(client);
  }
}

/**
 * Upload a file over SFTP: written to a temporary name next to `remotePath`, then renamed over it (atomic on the
 * server, posix-rename@openssh.com). `mode` defaults to 0600. Used by deploys (Phase A2).
 */
export async function sftpPut(t: SshTarget, remotePath: string, data: Buffer | NodeJS.ReadableStream, o: { mode?: number; timeoutMs?: number } = {}): Promise<void> {
  if (!remotePath || /[\0\n\r]/.test(remotePath) || remotePath.endsWith("/")) throw new Error("Invalid remote path");
  const timeoutMs = o.timeoutMs ?? 120_000;
  const client = await connectPinned(t);
  let timer: NodeJS.Timeout | undefined;
  let sftp: SFTPWrapper | undefined;
  const tmp = `${remotePath}.wfos-tmp-${randomBytes(6).toString("hex")}`;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new SshTimeoutError(`Upload timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      client.on("error", (e) => reject(connectError(e, false)));
      client.on("close", () => reject(new SshConnectError("The connection closed before the upload finished")));
      client.sftp((err, s) => {
        if (err) return reject(new SshConnectError(`SFTP is not available: ${err.message}`));
        sftp = s;
        const ws = s.createWriteStream(tmp, { mode: o.mode ?? 0o600 });
        ws.on("error", (e: Error) => reject(new Error(`Upload failed: ${e.message}`)));
        const moved = (e?: Error | null) => (e ? reject(new Error(`Could not move the upload into place: ${e.message}`)) : resolve());
        ws.on("close", () => {
          try {
            s.ext_openssh_rename(tmp, remotePath, moved);
          } catch {
            // not OpenSSH (no posix-rename extension): remove the old file, then a plain rename (not atomic)
            s.unlink(remotePath, () => s.rename(tmp, remotePath, moved));
          }
        });
        if (Buffer.isBuffer(data)) ws.end(data);
        else {
          const src = data instanceof Readable ? data : Readable.from(data as AsyncIterable<Buffer>);
          src.on("error", (e: Error) => {
            ws.destroy();
            reject(new Error(`Upload source failed: ${e.message}`));
          });
          src.pipe(ws);
        }
      });
    });
  } catch (e) {
    // best effort: do not leave the temporary file behind
    if (sftp) await new Promise<void>((r) => sftp!.unlink(tmp, () => r()));
    throw e;
  } finally {
    clearTimeout(timer);
    closeClient(client);
  }
}

export const HELPER_PATH = "/usr/local/sbin/wfos-app-helper";

/** sudo / shell messages that mean the helper (or its sudoers rule) is not installed. */
const HELPER_MISSING_RE = /a password is required|command not found|no such file|is not allowed to execute|not in the sudoers|sudo: a terminal is required/i;

/**
 * What a server reports about itself (`sudo -n wfos-app-helper info`). Throws HelperMissingError when sudo cannot
 * run the helper, HelperOutdatedError (with the info) when it is older than WFOS_HELPER_VERSION.
 */
export async function probeServer(t: SshTarget): Promise<ServerInfo> {
  const r = await sshExec(t, `sudo -n ${HELPER_PATH} info`, { timeoutMs: 30_000, maxOutputBytes: 64_000 });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
    if (r.code === 127 || HELPER_MISSING_RE.test(detail)) throw new HelperMissingError(detail ? `wfos-app-helper could not run: ${detail}` : undefined);
    throw new Error(`wfos-app-helper info failed (exit ${r.code ?? "signal"}): ${detail}`);
  }
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error("wfos-app-helper info did not print JSON");
  }
  const parsed = serverInfoSchema.safeParse(json);
  if (!parsed.success) throw new Error("wfos-app-helper info printed an unexpected shape");
  if (parsed.data.helperVersion < WFOS_HELPER_VERSION) throw new HelperOutdatedError(parsed.data);
  return parsed.data;
}
