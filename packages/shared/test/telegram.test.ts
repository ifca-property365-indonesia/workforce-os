import { describe, expect, it } from "vitest";
import { hashLinkCode, newCallbackId, newLinkCode, signCallback, verifyCallback } from "../src/telegram";

process.env.AUTH_SECRET = "x".repeat(40);

describe("telegram callbacks", () => {
  it("fit Telegram's 64-byte callback_data and verify", () => {
    const id = newCallbackId();
    const data = signCallback(id);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(verifyCallback(data)).toBe(id);
  });
  it("reject forged, altered or truncated data", () => {
    const data = signCallback(newCallbackId());
    const other = signCallback(newCallbackId());
    expect(verifyCallback(`${data.split(".")[0]}.${other.split(".")[1]}`)).toBeNull();
    expect(verifyCallback(data.slice(0, -1))).toBeNull();
    expect(verifyCallback("approve:00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(verifyCallback("")).toBeNull();
  });
  it("link codes are 8 unambiguous characters, hashed case-insensitively", () => {
    const { code, hash } = newLinkCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(hashLinkCode(` ${code.toLowerCase()} `)).toBe(hash);
  });
});
