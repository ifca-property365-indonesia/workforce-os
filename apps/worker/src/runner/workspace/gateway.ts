import http from "node:http";
import https from "node:https";
import net from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import { isBlockedAddress } from "@wfos/shared/netguard";
import type { ClaudeCredential } from "@wfos/db/claude";

/**
 * Per-run gateway on two Unix sockets (bound into the sandbox, which has no other network):
 *
 * api.sock    — reverse proxy to the Anthropic API. Accepts only the run's dummy token, replaces it with the
 *               workspace's real credential, and forwards only the Messages API. The sandbox never holds the
 *               real credential, so nothing inside it (commands, scripts, the model) can read or leak it.
 * egress.sock — HTTP CONNECT proxy with the employee's host allow-list. DNS is resolved here and private
 *               addresses are refused (same policy as safeFetch). Plain HTTP is refused.
 */

export interface GatewayEvent {
  kind: "api" | "egress_allowed" | "egress_denied";
  detail: string;
}

export interface GatewayOptions {
  socketDir: string;
  runToken: string;
  credential: ClaudeCredential;
  egressAllow: string[];
  /** default https://api.anthropic.com; tests point it at a local stub */
  upstream?: string;
  onEvent?: (e: GatewayEvent) => void;
  /** response headers of every API call (rate-limit meter, Phase 2) */
  onApiHeaders?: (headers: http.IncomingHttpHeaders) => void;
  /** test hooks */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  isBlocked?: (ip: string) => boolean;
  /** tests only: connect here instead of :443 after the allow-list check */
  connectPort?: number;
}

const API_PATHS = [/^\/v1\/messages(\/count_tokens)?(\?.*)?$/];
const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `registry.npmjs.org` matches exactly; `*.pypi.org` matches subdomains (not pypi.org itself). */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

export interface Gateway {
  close(): Promise<void>;
}

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
  await mkdir(o.socketDir, { recursive: true, mode: 0o755 });
  const upstream = new URL(o.upstream ?? process.env.WFOS_ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com");
  const resolve = o.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true }));
  const blocked = o.isBlocked ?? isBlockedAddress;

  const api = http.createServer((req, res) => {
    const deny = (code: number, why: string) => {
      o.onEvent?.({ kind: "api", detail: `denied ${req.method} ${req.url}: ${why}` });
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "permission_error", message: `gateway: ${why}` } }));
    };
    if (!API_PATHS.some((re) => re.test(req.url ?? ""))) return deny(403, "path not allowed");
    const presented = String(req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!presented || !sameToken(presented, o.runToken)) return deny(401, "unknown run token");
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== "authorization" && k !== "x-api-key" && v !== undefined) headers[k] = v;
    if (o.credential.type === "api_key") headers["x-api-key"] = o.credential.secret;
    else headers.authorization = `Bearer ${o.credential.secret}`;
    const mod = upstream.protocol === "https:" ? https : http;
    const target = new URL(req.url ?? "/", upstream);
    const up = mod.request(target, { method: req.method, headers }, (ur) => {
      o.onApiHeaders?.(ur.headers);
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
      res.writeHead(ur.statusCode ?? 502, out);
      ur.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) deny(502, `upstream error: ${e.message}`);
      else res.destroy();
    });
    req.pipe(up);
  });

  const egress = http.createServer((req, res) => {
    o.onEvent?.({ kind: "egress_denied", detail: `plain HTTP ${req.method} ${req.url}` });
    res.writeHead(403).end("only HTTPS via CONNECT to allow-listed hosts");
  });
  egress.on("connect", async (req, client: net.Socket, head) => {
    const deny = (why: string) => {
      o.onEvent?.({ kind: "egress_denied", detail: `${req.url}: ${why}` });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    };
    const m = /^([^:\s]+):(\d+)$/.exec(req.url ?? "");
    if (!m) return deny("bad target");
    const [, host, port] = m as unknown as [string, string, string];
    if (port !== "443") return deny("only port 443");
    if (net.isIP(host) || !hostAllowed(host, o.egressAllow)) return deny("host not allow-listed");
    let addrs: { address: string; family: number }[];
    try {
      addrs = await resolve(host);
    } catch {
      return deny("DNS lookup failed");
    }
    if (!addrs.length || addrs.some((a) => blocked(a.address))) return deny("resolves to a non-public address");
    const up = net.connect(o.connectPort ?? 443, addrs[0]!.address, () => {
      o.onEvent?.({ kind: "egress_allowed", detail: `${host}:443` });
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });

  const listen = async (server: http.Server, file: string) => {
    await rm(file, { force: true });
    await new Promise<void>((r, j) => {
      server.once("error", j);
      server.listen(file, () => r());
    });
    // the sandbox runs as an unprivileged dynamic UID; the directory itself is reachable only from this run's unit
    await chmod(file, 0o666);
  };
  await listen(api, `${o.socketDir}/api.sock`);
  await listen(egress, `${o.socketDir}/egress.sock`);

  return {
    close: async () => {
      await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => egress.close(r))]);
      api.closeAllConnections?.();
    },
  };
}
