import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import type { DomainCheck, DomainCheckStatus } from "./index";

/**
 * Whether the names of a live environment point at its server (Phase B1): A/AAAA of every name, asked of public DNS
 * (1.1.1.1 and 8.8.8.8, 5 s), compared with the server's own public address(es) (its host resolved the same way, an
 * IP literal as is). Used by the web on demand (the DNS panel) and by the worker before a live release is published.
 */

/** The two lookups the check needs (node:dns Resolver; tests pass a fake). */
export interface DomainResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

export const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
export const DNS_TIMEOUT_MS = 5000;

/** A resolver that asks public DNS only (never the host's own resolver, /etc/hosts or a split-horizon answer). */
export function publicResolver(): DomainResolver {
  const r = new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  r.setServers(PUBLIC_DNS_SERVERS);
  return r;
}

/** "no such name" / "no record of that type": the name has no address of that family (not an error) */
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA", "ENONAME"]);

/** One canonical spelling per address (IPv6 compressed, lower case), so answers compare with ===. */
export function normalizeIp(ip: string): string {
  const s = ip.trim().toLowerCase();
  if (isIP(s) !== 6) return s;
  try {
    return new URL(`http://[${s}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return s;
  }
}

type Lookup = { addresses: string[]; error: string | null };

async function lookupAll(r: DomainResolver, name: string): Promise<Lookup> {
  const one = async (fn: (n: string) => Promise<string[]>): Promise<Lookup> => {
    try {
      return { addresses: (await fn(name)).map(normalizeIp), error: null };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && NO_RECORDS.has(code)) return { addresses: [], error: null };
      return { addresses: [], error: typeof code === "string" ? code : (e as Error).message || "lookup failed" };
    }
  };
  const [a, aaaa] = await Promise.all([one((n) => r.resolve4(n)), one((n) => r.resolve6(n))]);
  return { addresses: [...new Set([...a.addresses, ...aaaa.addresses])], error: a.error ?? aaaa.error };
}

/** worst first: a definite wrong answer is the most useful thing to show, then a missing record, then "could not tell" */
const SEVERITY: DomainCheckStatus[] = ["wrong", "missing", "error", "ok"];

/**
 * ok: every name resolves to at least one of the server's addresses and to nothing else; wrong: some name resolves
 * elsewhere (also alongside the right address); missing: some name has no A/AAAA record (NXDOMAIN, no data); error:
 * public DNS did not answer (or the server's own address could not be found). Never throws.
 */
export async function checkDomains(names: string[], serverHost: string, resolver: DomainResolver = publicResolver()): Promise<DomainCheck> {
  const checkedAt = new Date().toISOString();
  const unique = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  let expected: string[];
  let serverError: string | null = null;
  if (isIP(serverHost.trim())) expected = [normalizeIp(serverHost)];
  else {
    const s = await lookupAll(resolver, serverHost.trim().toLowerCase());
    expected = s.addresses;
    if (!expected.length) serverError = s.error ?? "no address";
  }
  const expectedSet = new Set(expected);
  const results: DomainCheck["names"] = [];
  for (const name of unique) {
    const l = await lookupAll(resolver, name);
    let status: DomainCheckStatus;
    if (l.error && !l.addresses.length) status = "error";
    else if (!l.addresses.length) status = "missing";
    else if (l.addresses.some((a) => !expectedSet.has(a))) status = expected.length ? "wrong" : "error";
    else status = l.error ? "error" : "ok";
    results.push({ name, status, found: l.addresses });
  }
  let status: DomainCheckStatus;
  if (serverError || !unique.length) status = "error";
  else status = SEVERITY.find((s) => results.some((r) => r.status === s)) ?? "error";
  return { status, expected, names: results, checkedAt };
}
