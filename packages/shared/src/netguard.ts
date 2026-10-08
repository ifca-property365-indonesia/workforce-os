import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

// ---------------------------------------------------------------------------
// Address policy: only public unicast addresses may be fetched.
// ---------------------------------------------------------------------------

// Separate lists: Node's BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules in the same list.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) are judged by their embedded IPv4 (see embeddedIpv4)
  ["64:ff9b::", 96], // NAT64 well-known prefix
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo (embeds IPv4)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds IPv4)
  ["fc00::", 7], // unique local (incl. fd00:ec2::254 metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked6.addSubnet(net, prefix, "ipv6");
}

/** Expand an IPv6 string to 8 hextets (handles "::" and a trailing dotted IPv4). */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array<string>(Math.max(0, fill)).fill("0"), ...t];
  if (parts.length !== 8) return null;
  const nums = parts.map((x) => parseInt(x, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** IPv4 embedded in an IPv4-mapped / -compatible / NAT64 IPv6 address, if any. */
function embeddedIpv4(ip: string): string | null {
  const h = ipv6Hextets(ip);
  if (!h) return null;
  const v4 = (a: number, b: number) => `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(5) && h[5] === 0xffff) return v4(h[6]!, h[7]!); // ::ffff:a.b.c.d
  if (zeros(6)) return v4(h[6]!, h[7]!); // ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4(h[6]!, h[7]!); // NAT64
  return null;
}

/** True when the address must never be fetched (anything that is not public unicast). Unparseable = blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return blocked4.check(bare, "ipv4");
  if (family === 6) {
    const inner = embeddedIpv4(bare);
    if (inner) return blocked4.check(inner, "ipv4");
    return blocked6.check(bare.replace(/%.*$/, ""), "ipv6");
  }
  return true;
}

// ---------------------------------------------------------------------------
// safeFetch: DNS resolved and validated by us, socket pinned to the validated IP,
// redirects followed manually with every hop re-validated, size and time caps.
// ---------------------------------------------------------------------------

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  /** total time budget across all hops */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** DNS resolver (injectable for tests) */
  resolve?: Resolver;
  /** address policy (injectable for tests); defaults to isBlockedAddress */
  isBlocked?: (ip: string) => boolean;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  status: number;
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: number;
}

export class SsrfBlockedError extends Error {
  readonly noRetry = true;
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

const defaultResolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

async function pinnedAddress(url: URL, resolve: Resolver, isBlocked: (ip: string) => boolean): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfBlockedError(`Only http(s) URLs are allowed (got ${url.protocol})`);
  if (url.username || url.password) throw new SsrfBlockedError("URLs with embedded credentials are not allowed");
  // WHATWG URL parsing already normalises decimal/octal/hex IPv4 forms (2130706433, 0x7f.1, 0177.0.0.1 → 127.0.0.1)
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfBlockedError("URL has no host");
  const literal = isIP(host);
  if (literal) {
    if (isBlocked(host)) throw new SsrfBlockedError(`Address ${host} is not a public address`);
    return { address: host, family: literal as 4 | 6 };
  }
  let records: { address: string; family: number }[];
  try {
    records = await resolve(host);
  } catch (e) {
    throw Object.assign(new Error(`DNS lookup failed for ${host}: ${(e as Error).message}`), { noRetry: true });
  }
  if (!records.length) throw Object.assign(new Error(`DNS lookup returned no address for ${host}`), { noRetry: true });
  // every record must be public, so a mixed answer cannot be used for rebinding
  const bad = records.find((r) => isBlocked(r.address));
  if (bad) throw new SsrfBlockedError(`${host} resolves to ${bad.address}, which is not a public address`);
  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function requestOnce(
  url: URL,
  pin: { address: string; family: 4 | 6 },
  opts: { headers: Record<string, string>; maxBytes: number; signal: AbortSignal },
): Promise<{ status: number; location?: string; contentType: string; body: Buffer; truncated: boolean }> {
  // The socket connects to the address we validated; no second DNS lookup happens (no rebinding window).
  const lookup: LookupFunction = (_hostname, options, cb) => {
    if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pin]);
    else cb(null, pin.address, pin.family);
  };
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v: { status: number; location?: string; contentType: string; body: Buffer; truncated: boolean }) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = mod.request(
      url,
      { method: "GET", headers: { "accept-encoding": "identity", ...opts.headers }, lookup, signal: opts.signal, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          finish({ status, location: res.headers.location, contentType, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (done) return;
          if (size + c.length > opts.maxBytes) {
            chunks.push(c.subarray(0, opts.maxBytes - size));
            finish({ status, contentType, body: Buffer.concat(chunks), truncated: true });
            res.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        res.on("end", () => finish({ status, contentType, body: Buffer.concat(chunks), truncated: false }));
        res.on("error", (e) => {
          if (!done) {
            done = true;
            reject(e);
          }
        });
      },
    );
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    req.end();
  });
}

export async function safeFetch(input: string, o: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = o.maxRedirects ?? 5;
  const maxBytes = o.maxBytes ?? 2_000_000;
  const resolve = o.resolve ?? defaultResolve;
  const isBlocked = o.isBlocked ?? isBlockedAddress;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 15_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfBlockedError("Invalid URL");
  }
  for (let hop = 0; ; hop++) {
    const pin = await pinnedAddress(url, resolve, isBlocked);
    const r = await requestOnce(url, pin, { headers: o.headers ?? {}, maxBytes, signal });
    if (r.location) {
      if (hop >= maxRedirects) throw new SsrfBlockedError(`Too many redirects (max ${maxRedirects})`);
      url = new URL(r.location, url);
      continue;
    }
    return { status: r.status, url: url.toString(), contentType: r.contentType, body: r.body.toString("utf8"), truncated: r.truncated, redirects: hop };
  }
}
