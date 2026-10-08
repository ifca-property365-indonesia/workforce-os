import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  totpCounter,
  verifyTotp,
} from "../src/totp";

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890", 8 digits)
const SEED = Buffer.from("12345678901234567890");
const VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it.each(VECTORS)("matches RFC 6238 at t=%i", (t, code) => {
    expect(hotp(SEED, Math.floor(t / 30), 8)).toBe(code);
    expect(totp(base32Encode(SEED), t * 1000, 8)).toBe(code);
  });

  it("round-trips base32", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  it("accepts the current code and ±1 step, rejects ±2", () => {
    const s = generateTotpSecret();
    const now = 1_800_000_000_000;
    expect(verifyTotp(s, totp(s, now), { timeMs: now })).toBe(totpCounter(now));
    expect(verifyTotp(s, totp(s, now - 30_000), { timeMs: now })).not.toBeNull();
    expect(verifyTotp(s, totp(s, now + 30_000), { timeMs: now })).not.toBeNull();
    expect(verifyTotp(s, totp(s, now - 60_000), { timeMs: now })).toBeNull();
  });

  it("rejects replay of an already-used code", () => {
    const s = generateTotpSecret();
    const now = 1_800_000_000_000;
    const used = verifyTotp(s, totp(s, now), { timeMs: now })!;
    expect(verifyTotp(s, totp(s, now), { timeMs: now, lastCounter: used })).toBeNull();
  });

  it("rejects malformed codes", () => {
    const s = generateTotpSecret();
    for (const c of ["", "12345", "1234567", "abcdef", "12 34 5"]) expect(verifyTotp(s, c)).toBeNull();
  });

  it("builds an otpauth URI", () => {
    const u = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "a@b.co", issuer: "Workforce OS" });
    expect(u).toMatch(/^otpauth:\/\/totp\/Workforce%20OS%3Aa%40b\.co\?/);
    expect(u).toContain("secret=JBSWY3DPEHPK3PXP");
  });
});

describe("recovery codes", () => {
  it("are hashed, single-use and format-tolerant", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const h of hashes) expect(codes.some((c) => h.includes(c))).toBe(false);
    const rest = consumeRecoveryCode(hashes, codes[3]!.toLowerCase().replace("-", " "))!;
    expect(rest).toHaveLength(9);
    expect(consumeRecoveryCode(rest, codes[3]!)).toBeNull();
    expect(consumeRecoveryCode(hashes, "AAAAA-AAAAA")).toBeNull();
  });
});
