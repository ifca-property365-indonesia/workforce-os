import { describe, expect, it } from "vitest";
import { exportRedact, redactSecrets, redactUrl, screenLeakage } from "../src/server";
import { assertPublicUrl, SsrfBlockedError, type Resolver } from "../src/netguard";

// fake secrets are assembled at runtime so no scanner mistakes this file for a leak
const FAKE = {
  slack: "xox" + "b-" + "1234567890-" + "AbCdEfGhIjKlMnOp",
  stripe: "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  stripeRestricted: "rk_" + "test_" + "51H8aBcDeFgHiJkLmNo",
  google: "AI" + "za" + "SyD" + "x".repeat(16) + "_-" + "Q".repeat(14),
  urlCreds: "postgres://" + "app_user:" + "s3cr3t-pass" + "@db.internal.example:5432/app",
  bearer: "Authorization: Bearer " + "eyJhbGciOi" + "Jsb2NhbCJ9-abc_DEF.123",
  assignment: "client_secret = " + "q1w2e3r4t5y6u7i8o9",
};

const rules = (text: string) => screenLeakage(text).map((f) => f.rule);

describe("new leak rules", () => {
  it.each([
    ["slack-token", FAKE.slack, "high"],
    ["stripe-key", FAKE.stripe, "high"],
    ["stripe-key", FAKE.stripeRestricted, "high"],
    ["google-api-key", FAKE.google, "high"],
    ["url-credentials", FAKE.urlCreds, "high"],
    ["bearer-token", FAKE.bearer, "high"],
    ["secret-assignment", FAKE.assignment, "medium"],
  ] as const)("%s flags its secret (%#)", (rule, secret, severity) => {
    const findings = screenLeakage(`config: ${secret} end`);
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule, severity })]));
    // the finding's excerpt never carries the secret itself
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it.each([
    ["slack-token", "use the xoxb-123 placeholder"],
    ["stripe-key", "the key looks like sk_live_short"],
    ["stripe-key", "sk_prod_abcdefghijklmnopqrstuvwx is not a Stripe mode"],
    ["google-api-key", "AIza" + "tooShort123"],
    ["url-credentials", "https://user@example.com/path (no password)"],
    ["url-credentials", "mail me at someone@example.com"],
    ["bearer-token", "send the Bearer header with your token"],
    ["secret-assignment", "token = process.env.X"],
    ["secret-assignment", "secret: short"],
    ["secret-assignment", "the api key is in the vault"],
  ] as const)("%s ignores a near miss: %s", (rule, text) => {
    expect(rules(text)).not.toContain(rule);
  });

  it("redactSecrets removes the new high-severity ones; medium findings stay for the log view", () => {
    const text = [FAKE.slack, FAKE.stripe, FAKE.google, FAKE.urlCreds, FAKE.bearer].join(" | ");
    const red = redactSecrets(text);
    for (const s of [FAKE.slack, FAKE.stripe, FAKE.google, "s3cr3t-pass", "Jsb2NhbCJ9-abc_DEF.123"]) expect(red).not.toContain(s);
  });
});

describe("exportRedact", () => {
  it("drops the user and password of a connection string", () => {
    const r = exportRedact(`DATABASE_URL=postgres://user:pass@db.example.com:5432/app`);
    expect(r.text).not.toContain("user:pass");
    expect(r.text).not.toContain(":pass@");
    expect(r.rules).toContain("url-credentials");
  });

  it("redacts medium findings too (a secret assignment), not only high ones", () => {
    const r = exportRedact(`set ${FAKE.assignment} before the run`);
    expect(r.text).not.toContain("q1w2e3r4t5y6u7i8o9");
    expect(r.rules).toContain("secret-assignment");
  });

  it("leaves ordinary text alone", () => {
    const text = "Reply within 2 days. token = process.env.X is read at startup. See https://docs.example.com/guide";
    expect(exportRedact(text)).toEqual({ text, rules: [] });
  });
});

describe("redactUrl: key-like path segments (looksLikeKey)", () => {
  it.each(["abcd-efgh-ijkl-mnop-qrst", "abcdefghijklmnopqrst", "AB12-CD34-EF56-GH78", "aB3dE6gH9jK2mN5pQ8sT1vW4"])("redacts %s", (seg) => {
    const found: string[] = [];
    const out = redactUrl(`https://mcp.example.com/v1/${seg}/sse`, found);
    expect(out).toBe("https://mcp.example.com/v1/redacted/sse");
    expect(found).toContain("url-key");
  });

  it.each(["github-mcp-server-2024", "v2", "mcp", "s3", "sse", "crm_v2-beta"])("keeps the name %s", (seg) => {
    const found: string[] = [];
    expect(redactUrl(`https://mcp.example.com/${seg}`, found)).toBe(`https://mcp.example.com/${seg}`);
    expect(found).toEqual([]);
  });

  it("redacts a key-like subdomain, never the registrable domain", () => {
    expect(redactUrl("https://abcdefghijklmnopqrst.mcp.example.com/x")).toBe("https://redacted.mcp.example.com/x");
    expect(redactUrl("https://mcp.abcdefghijklmnopqrstuvwxyz.com/x")).toBe("https://mcp.abcdefghijklmnopqrstuvwxyz.com/x");
  });
});

describe("assertPublicUrl", () => {
  const publicDns: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const privateDns: Resolver = async () => [{ address: "10.0.0.7", family: 4 }];
  const mixedDns: Resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const noDns: Resolver = async () => [];
  const never: Resolver = async () => {
    throw new Error("the resolver must not be asked");
  };

  it.each([
    "http://127.0.0.1/",
    "http://127.8.9.10:8080/x",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/",
    "https://10.255.255.255/mcp",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[fd00:ec2::254]/",
    "http://2130706433/", // 127.0.0.1 as a number
    "http://0x7f.1/",
  ])("blocks %s without asking DNS", async (url) => {
    await expect(assertPublicUrl(url, { resolver: never })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a public address, and a name that resolves to public addresses only", async () => {
    await expect(assertPublicUrl("https://93.184.216.34/x", { resolver: never })).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://mcp.example.com/mcp", { resolver: publicDns })).resolves.toBeUndefined();
  });

  it("blocks a name that resolves to a private address, to a mix, or to nothing", async () => {
    for (const resolver of [privateDns, mixedDns, noDns]) {
      await expect(assertPublicUrl("https://mcp.example.com/mcp", { resolver })).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  it("lets allowHosts through as-is (case-insensitive, IPv6 brackets ignored)", async () => {
    await expect(assertPublicUrl("http://localhost:3000/mcp", { allowHosts: ["localhost"], resolver: never })).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://MCP.Internal.Example/mcp", { allowHosts: ["mcp.internal.example"], resolver: never })).resolves.toBeUndefined();
    await expect(assertPublicUrl("http://[::1]:8080/", { allowHosts: ["::1"], resolver: never })).resolves.toBeUndefined();
    // only the listed host: another private one is still refused
    await expect(assertPublicUrl("http://10.0.0.2/", { allowHosts: ["10.0.0.1"], resolver: never })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it.each(["ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)"])("refuses the scheme of %s", async (url) => {
    await expect(assertPublicUrl(url, { resolver: publicDns, allowHosts: ["example.com"] })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("leak pattern follow-ups", () => {
  it("catches credentials with an empty username", () => {
    expect(screenLeakage("redis://:hunter2hunter2@cache:6379/0").map((f) => f.rule)).toContain("url-credentials");
  });
  it("catches JSON-quoted secret keys", () => {
    expect(screenLeakage('{"api_key": "Zm9vYmFyYmF6cXV4MTIz"}').map((f) => f.rule)).toContain("secret-assignment");
  });
  it("does not flag environment lookups", () => {
    for (const t of ["api_key = process.env.API_KEY", "client_secret = os.environ['X']", "auth_token: ${AUTH_TOKEN_VALUE}", "apiKey: $API_KEY_FROM_ENV"]) {
      expect(screenLeakage(t).map((f) => f.rule)).not.toContain("secret-assignment");
    }
  });
});

describe("re-review follow-ups", () => {
  it("url-credentials stays fast on long word-boundary runs", () => {
    const started = Date.now();
    screenLeakage("ab-".repeat(40_000));
    screenLeakage("a.b+".repeat(30_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it.each([
    ["wfos_" + "a1B2c3D4".repeat(5), "wfos-token"],
    ["whsec_" + "Zz09Yy87".repeat(5), "wfos-token"],
    ["123456789:AAH" + "x1Y2z3".repeat(6), "telegram-bot-token"],
    ["glpat-" + "Ab1".repeat(8), "vendor-token"],
    ["authorization: bearer " + "abcDEF123456ghiJKL", "bearer-token"],
    ["token=" + "Q1w2E3r4T5y6U7", "secret-assignment"],
  ])("flags %s", (text, rule) => {
    expect(screenLeakage(text).map((f) => f.rule)).toContain(rule);
  });
});
