import { describe, expect, it } from "vitest";
import { checkDomains, normalizeIp, publicResolver, PUBLIC_DNS_SERVERS, type DomainResolver } from "@wfos/shared/dns";

const err = (code: string) => Object.assign(new Error(`query ${code}`), { code });

/** answers from a table: name → { a, aaaa } (an Error rejects) */
function fakeResolver(table: Record<string, { a?: string[] | Error; aaaa?: string[] | Error }>): DomainResolver & { asked: string[] } {
  const asked: string[] = [];
  const answer = (name: string, v: string[] | Error | undefined) => {
    asked.push(name);
    if (v instanceof Error) return Promise.reject(v);
    if (!v) return Promise.reject(err(name in table ? "ENODATA" : "ENOTFOUND"));
    return Promise.resolve(v);
  };
  return {
    asked,
    resolve4: (n) => answer(n, table[n]?.a),
    resolve6: (n) => answer(n, table[n]?.aaaa),
  };
}

const SERVER = { "srv.example.net": { a: ["203.0.113.10"], aaaa: ["2001:db8::10"] } };

describe("checkDomains (shared DNS util)", () => {
  it("ok: every name resolves to the server's addresses only (IPv6 compared normalised)", async () => {
    const r = fakeResolver({ ...SERVER, "shop.client.co.id": { a: ["203.0.113.10"], aaaa: ["2001:DB8:0:0::10"] }, "www.shop.client.co.id": { a: ["203.0.113.10"] } });
    const c = await checkDomains(["shop.client.co.id", "WWW.shop.client.co.id"], "srv.example.net", r);
    expect(c.status).toBe("ok");
    expect(c.expected).toEqual(["203.0.113.10", "2001:db8::10"]);
    expect(c.names).toEqual([
      { name: "shop.client.co.id", status: "ok", found: ["203.0.113.10", "2001:db8::10"] },
      { name: "www.shop.client.co.id", status: "ok", found: ["203.0.113.10"] },
    ]);
    expect(Date.parse(c.checkedAt)).toBeGreaterThan(0);
  });

  it("an IP literal host is the expected address as is (not resolved)", async () => {
    const r = fakeResolver({ "a.client.org": { a: ["198.51.100.4"] } });
    const c = await checkDomains(["a.client.org"], "198.51.100.4", r);
    expect(c).toMatchObject({ status: "ok", expected: ["198.51.100.4"] });
    expect(r.asked).not.toContain("198.51.100.4");
  });

  it("wrong: a name resolves elsewhere, also alongside the right address (an old AAAA left behind)", async () => {
    const r = fakeResolver({ ...SERVER, "a.client.org": { a: ["203.0.113.10"], aaaa: ["2001:db8::99"] }, "www.a.client.org": { a: ["203.0.113.10"] } });
    const c = await checkDomains(["a.client.org", "www.a.client.org"], "srv.example.net", r);
    expect(c.status).toBe("wrong");
    expect(c.names.map((n) => n.status)).toEqual(["wrong", "ok"]);
  });

  it("missing: NXDOMAIN or no A/AAAA; wrong wins over missing in the overall status", async () => {
    const r = fakeResolver({ ...SERVER, "empty.client.org": {}, "bad.client.org": { a: ["198.51.100.1"] } });
    expect((await checkDomains(["nope.client.org"], "srv.example.net", r)).status).toBe("missing");
    expect((await checkDomains(["empty.client.org"], "srv.example.net", r)).names[0]).toEqual({ name: "empty.client.org", status: "missing", found: [] });
    expect((await checkDomains(["empty.client.org", "bad.client.org"], "srv.example.net", r)).status).toBe("wrong");
  });

  it("error: public DNS does not answer, or the server's own address cannot be found; never throws", async () => {
    const timeout = fakeResolver({ ...SERVER, "slow.client.org": { a: err("ETIMEOUT"), aaaa: err("ETIMEOUT") } });
    const c = await checkDomains(["slow.client.org"], "srv.example.net", timeout);
    expect(c.status).toBe("error");
    expect(c.names[0]).toEqual({ name: "slow.client.org", status: "error", found: [] });
    // the right A, but AAAA failed: not known to be ok
    const half = fakeResolver({ ...SERVER, "half.client.org": { a: ["203.0.113.10"], aaaa: err("ESERVFAIL") } });
    expect((await checkDomains(["half.client.org"], "srv.example.net", half)).status).toBe("error");
    // no address for the server itself: nothing to compare with
    const noServer = fakeResolver({ "a.client.org": { a: ["203.0.113.10"] } });
    const c2 = await checkDomains(["a.client.org"], "gone.example.net", noServer);
    expect(c2).toMatchObject({ status: "error", expected: [] });
    expect(c2.names[0]!.status).toBe("error");
    // nothing to check
    expect((await checkDomains([], "203.0.113.10", noServer)).status).toBe("error");
  });

  it("asks public DNS (1.1.1.1, 8.8.8.8), never the host's resolver; addresses normalised", () => {
    expect(PUBLIC_DNS_SERVERS).toEqual(["1.1.1.1", "8.8.8.8"]);
    const r = publicResolver() as unknown as { getServers(): string[] };
    expect(r.getServers()).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(normalizeIp("2001:DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeIp(" 203.0.113.10 ")).toBe("203.0.113.10");
  });
});
