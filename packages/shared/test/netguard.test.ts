import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isBlockedAddress, safeFetch, SsrfBlockedError, type Resolver } from "../src/netguard";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "239.255.255.250",
    "255.255.255.255", "192.0.2.10", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:0:4136:e378::1",
    "[::1]", "fe80::1%eth0", "not-an-ip", "",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

// A local server stands in for "the internet". Only 127.0.0.1 is exempted (test policy),
// so every other private target is still judged by the real policy.
let server: http.Server;
let port = 0;
let connections = 0;
const routes = new Map<string, (res: http.ServerResponse) => void>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const h = routes.get(req.url ?? "/");
    if (h) h(res);
    else res.end(`hello from ${req.headers.host}`);
  });
  server.on("connection", () => connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  connections = 0;
  routes.clear();
});

const testPolicy = (ip: string) => ip !== "127.0.0.1" && isBlockedAddress(ip);
function resolver(map: Record<string, string[]>): Resolver {
  return async (host: string) => {
    const a = map[host];
    if (!a) throw new Error("ENOTFOUND");
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}
const viaPublic = () => ({ resolve: resolver({ "public.example": ["127.0.0.1"] }), isBlocked: testPolicy });

describe("safeFetch bypass classes (default policy, nothing may connect)", () => {
  it.each([
    ["decimal IPv4", `http://2130706433:PORT/`],
    ["hex IPv4", `http://0x7f000001:PORT/`],
    ["octal IPv4", `http://0177.0.0.1:PORT/`],
    ["dotted hex", `http://0x7f.0x0.0x0.0x1:PORT/`],
    ["short form", `http://127.1:PORT/`],
    ["IPv4-mapped IPv6", `http://[::ffff:127.0.0.1]:PORT/`],
    ["IPv6 loopback", `http://[::1]:PORT/`],
    ["metadata", `http://169.254.169.254/latest/meta-data/`],
    ["unspecified", `http://0.0.0.0:PORT/`],
  ])("rejects %s", async (_label, raw) => {
    await expect(safeFetch(raw.replace("PORT", String(port)), { resolve: resolver({}) })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(connections).toBe(0);
  });

  it("rejects a hostname resolving to 10.x", async () => {
    const r = resolver({ "intranet.example": ["10.1.2.3"] });
    await expect(safeFetch(`http://intranet.example:${port}/`, { resolve: r })).rejects.toThrow(/10\.1\.2\.3.*not a public address/);
    expect(connections).toBe(0);
  });

  it("rejects when any DNS record is private (mixed answer)", async () => {
    const r = resolver({ "mixed.example": ["93.184.216.34", "127.0.0.1"] });
    await expect(safeFetch(`http://mixed.example/`, { resolve: r })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects localhost by name", async () => {
    await expect(safeFetch(`http://localhost:${port}/`, { resolve: resolver({ localhost: ["127.0.0.1"] }) })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(connections).toBe(0);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://127.0.0.1:6379/_INFO", "data:text/plain,hi", "javascript:alert(1)"])(
    "rejects non-http scheme %s",
    async (u) => {
      await expect(safeFetch(u, { resolve: resolver({}) })).rejects.toBeInstanceOf(SsrfBlockedError);
    },
  );

  it("rejects embedded credentials and garbage", async () => {
    await expect(safeFetch("http://user:pw@example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(safeFetch("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("safeFetch against a local server (only 127.0.0.1 exempted)", () => {
  it("fetches a public-looking host and returns the body", async () => {
    const r = await safeFetch(`http://public.example:${port}/`, viaPublic());
    expect(r.status).toBe(200);
    expect(r.body).toBe(`hello from public.example:${port}`);
  });

  it("re-validates redirects: a redirect to 169.254.169.254 is refused", async () => {
    routes.set("/go", (res) => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/iam" }).end());
    await expect(safeFetch(`http://public.example:${port}/go`, viaPublic())).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("re-validates redirects: a redirect to a host resolving to 10.x is refused", async () => {
    routes.set("/go", (res) => res.writeHead(301, { location: "http://evil.example/" }).end());
    const r = resolver({ "public.example": ["127.0.0.1"], "evil.example": ["10.0.0.5"] });
    await expect(safeFetch(`http://public.example:${port}/go`, { resolve: r, isBlocked: testPolicy })).rejects.toThrow(/10\.0\.0\.5/);
  });

  it("re-validates redirects: a redirect to an IPv4-mapped loopback is refused", async () => {
    routes.set("/go", (res) => res.writeHead(307, { location: `http://[::ffff:7f00:1]:${port}/` }).end());
    await expect(safeFetch(`http://public.example:${port}/go`, viaPublic())).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("follows up to 5 redirects and refuses the 6th", async () => {
    for (let i = 0; i < 7; i++) routes.set(`/r${i}`, (res) => res.writeHead(302, { location: `/r${i + 1}` }).end());
    routes.set("/r7", (res) => res.end("end"));
    const ok = await safeFetch(`http://public.example:${port}/r2`, viaPublic());
    expect(ok.redirects).toBe(5);
    await expect(safeFetch(`http://public.example:${port}/r0`, viaPublic())).rejects.toThrow(/Too many redirects/);
  });

  it("pins the connection to the validated address (DNS rebinding)", async () => {
    // the first answer passes validation; any second lookup would return a blocked address
    let n = 0;
    const rebinding: Resolver = async () => (n++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }]);
    const r = await safeFetch(`http://rebind.example:${port}/`, { resolve: rebinding, isBlocked: testPolicy });
    expect(r.status).toBe(200);
    expect(n).toBe(1); // the socket did not resolve the name again
  });

  it("caps the response size", async () => {
    routes.set("/big", (res) => res.end("x".repeat(50_000)));
    const r = await safeFetch(`http://public.example:${port}/big`, { ...viaPublic(), maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(1000);
  });

  it("enforces the time cap", async () => {
    routes.set("/slow", (res) => void setTimeout(() => res.end("late"), 3000));
    const started = Date.now();
    await expect(safeFetch(`http://public.example:${port}/slow`, { ...viaPublic(), timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
