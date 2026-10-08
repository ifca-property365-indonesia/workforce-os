import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 4648 base32 (no padding) and RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;

/** 160-bit secret, base32 encoded (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpCounter(timeMs = Date.now()): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secretBase32: string, timeMs = Date.now(), digits = 6): string {
  return hotp(base32Decode(secretBase32), totpCounter(timeMs), digits);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verify a 6-digit code within ±window steps. Returns the matched counter, or null.
 * Codes at or below `lastCounter` are rejected so a code cannot be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, opts: { timeMs?: number; window?: number; lastCounter?: number | null } = {}): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretBase32);
  const now = totpCounter(opts.timeMs);
  const window = opts.window ?? 1;
  for (let d = -window; d <= window; d++) {
    const counter = now + d;
    if (opts.lastCounter != null && counter <= opts.lastCounter) continue;
    if (safeEqual(hotp(key, counter), c)) return counter;
  }
  return null;
}

export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: "SHA1", digits: "6", period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// Recovery codes: 10 single-use codes of 10 base32 characters (50 bits each), stored as SHA-256 hashes.

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`wfos-recovery:${normalizeRecoveryCode(code)}`).digest("hex");
}

export function generateRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** Returns the remaining hashes when the code matches one (it is consumed), else null. */
export function consumeRecoveryCode(hashes: string[], code: string): string[] | null {
  const h = hashRecoveryCode(code);
  const i = hashes.findIndex((x) => safeEqual(x, h));
  if (i < 0) return null;
  return [...hashes.slice(0, i), ...hashes.slice(i + 1)];
}
