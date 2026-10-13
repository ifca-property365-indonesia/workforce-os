import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// SSH key material with node:crypto only (no ssh2), so @wfos/db can create a workspace key without loading the
// SSH client. Formats are OpenSSH's: the one-line public key, the "openssh-key-v1" private key, and the
// `ssh-keygen -lf` fingerprint.
// ---------------------------------------------------------------------------

/** SSH wire "string": uint32 length + bytes. */
function sshString(b: Buffer | string): Buffer {
  const data = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** `SHA256:<base64, no padding>` of a public key blob, the format `ssh-keygen -lf` prints. Accepts the blob or its base64. */
export function sshFingerprint(blob: Buffer | string): string {
  const raw = typeof blob === "string" ? Buffer.from(blob, "base64") : blob;
  return `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`;
}

/** The algorithm name a public key blob starts with (e.g. "ssh-ed25519"), or null when the blob is malformed. */
export function sshKeyBlobAlgo(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const n = blob.readUInt32BE(0);
  if (n < 1 || n > 64 || blob.length < 4 + n) return null;
  const algo = blob.subarray(4, 4 + n).toString("latin1");
  return /^[a-z0-9@.-]+$/.test(algo) ? algo : null;
}

/** OpenSSH comments end up in authorized_keys: one printable line, no spaces needed for ours. */
function cleanComment(comment: string): string {
  return comment.replace(/[^\x21-\x7e]/g, "").slice(0, 100);
}

/**
 * A new ed25519 key pair for a workspace: the public key as one OpenSSH line (`ssh-ed25519 AAAA… <comment>`), the
 * private key as an unencrypted "OPENSSH PRIVATE KEY" PEM (what ssh2 and OpenSSH read) and the public key's
 * fingerprint. The private key is a secret: store it encrypted, never log it.
 */
export function generateWorkspaceKey(comment: string): { publicKey: string; privateKey: string; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  if (pub.length !== 32 || seed.length !== 32) throw new Error("Unexpected ed25519 key size");
  const name = cleanComment(comment);

  const pubBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  // private section: check ints, key type, public key, seed||public, comment, then padding 1,2,3… to the cipher
  // block size (8 for "none")
  const check = randomBytes(4).readUInt32BE(0);
  let priv = Buffer.concat([uint32(check), uint32(check), sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(name)]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"), // cipher
    sshString("none"), // kdf
    sshString(Buffer.alloc(0)), // kdf options
    uint32(1), // number of keys
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  seed.fill(0);
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString("base64")}${name ? ` ${name}` : ""}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`,
    fingerprint: sshFingerprint(pubBlob),
  };
}
