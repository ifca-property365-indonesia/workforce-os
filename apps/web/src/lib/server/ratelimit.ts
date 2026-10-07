import "server-only";
import type { NextRequest } from "next/server";
import { HttpError } from "./auth";
import { redis } from "./queue";

/**
 * Client IP. Nginx resolves the real visitor address behind Cloudflare (realip module)
 * and passes it as X-Real-IP; the header is overwritten there, so clients cannot spoof it.
 */
export function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? "unknown";
}

/** Fixed-window counter. Throws 429 once `max` hits land inside `windowSec`. */
export async function rateLimit(key: string, max: number, windowSec: number, message = "Too many attempts. Try again later.") {
  const k = `wfos:rl:${key}`;
  const n = await redis().incr(k);
  if (n === 1) await redis().expire(k, windowSec);
  if (n > max) throw new HttpError(429, message);
}

export async function resetRateLimit(key: string) {
  await redis().del(`wfos:rl:${key}`);
}
