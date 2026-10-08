import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * Telegram Bot API transport and the signed, single-use approval buttons.
 * callback_data (max 64 bytes) = "<id>.<hmac>": the id points to a single-use row bound to one user and one
 * approval; the HMAC (keyed with AUTH_SECRET) stops forged or altered ids before any database lookup.
 */
export type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let fetchImpl: TelegramFetch | null = null;
/** Tests replace the transport: no real Telegram calls. */
export function setTelegramFetch(f: TelegramFetch | null): void {
  fetchImpl = f;
}

export function telegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

export async function telegramCall(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const f = fetchImpl ?? (fetch as unknown as TelegramFetch);
  const r = await f(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return r.json();
}

function key(): string {
  const k = process.env.AUTH_SECRET;
  if (!k || k.length < 32) throw new Error("AUTH_SECRET must be set for Telegram callbacks");
  return k;
}

export function newCallbackId(): string {
  return randomBytes(12).toString("base64url"); // 16 chars
}

export function signCallback(id: string): string {
  return `${id}.${createHmac("sha256", key()).update(`tg-cb:${id}`).digest("base64url").slice(0, 22)}`;
}

/** Returns the callback id when the signature is valid, else null. */
export function verifyCallback(data: string): string | null {
  const [id, sig] = data.split(".");
  if (!id || !sig || !/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
  const expected = signCallback(id).split(".")[1]!;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

/** 8-character linking code (no ambiguous characters) and its stored hash. */
export function newLinkCode(): { code: string; hash: string } {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return { code, hash: hashLinkCode(code) };
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(`tg-link:${code.trim().toUpperCase()}`).digest("hex");
}
