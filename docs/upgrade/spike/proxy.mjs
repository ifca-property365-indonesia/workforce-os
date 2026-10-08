// Host-side egress proxy (spike): HTTP CONNECT on a Unix socket, hostname allow-list, port 443 only,
// DNS resolved here and private addresses refused (same policy as safeFetch).
import net from "node:net";
import { lookup } from "node:dns/promises";
const ALLOW = new Set((process.env.ALLOW ?? "").split(","));
const PRIVATE = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|f[cd]|fe80)/;
const srv = net.createServer((c) => {
  c.once("data", async (buf) => {
    const m = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]\r\n/.exec(buf.toString("latin1"));
    const deny = (why) => { console.log(`DENY ${m?.[1] ?? "?"}:${m?.[2] ?? "?"} ${why}`); c.end("HTTP/1.1 403 Forbidden\r\n\r\n"); };
    if (!m) return deny("not CONNECT");
    const [, host, port] = m;
    if (port !== "443" || !ALLOW.has(host)) return deny("not allow-listed");
    let addrs; try { addrs = await lookup(host, { all: true }); } catch { return deny("dns"); }
    if (addrs.some((a) => PRIVATE.test(a.address))) return deny("private address");
    const up = net.connect(443, addrs[0].address, () => { console.log(`ALLOW ${host}:443 -> ${addrs[0].address}`); c.write("HTTP/1.1 200 Connection established\r\n\r\n"); up.pipe(c); c.pipe(up); });
    up.on("error", () => c.destroy()); c.on("error", () => up.destroy());
  });
});
srv.listen(process.env.SOCK, () => console.log("proxy listening"));
