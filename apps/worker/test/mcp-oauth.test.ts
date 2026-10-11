import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { credentials, db } from "@wfos/db";
import { MCP_OAUTH_FETCH_TIMEOUT_MS, type McpCredentialConfig } from "@wfos/shared";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { getExternalMcpServers, REFRESH_LOCK_MS } from "../src/lib/settings";
import { makeWorkspace } from "./fixtures";
import { redisModule } from "./transport";

/** The SDK's token refresh is replaced: no network. */
const sdk = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ refreshAuthorization: sdk.refresh }));

/** Enough Redis for the refresh lock: SET NX PX, GET, and the compare-and-delete script. */
const kv = new Map<string, { value: string; expiresAt?: number }>();
const lockSets: string[] = [];
const lockTtls: number[] = [];
const live = (k: string) => {
  const e = kv.get(k);
  if (e?.expiresAt !== undefined && e.expiresAt <= Date.now()) kv.delete(k);
  return kv.get(k);
};
Object.assign(redisModule.redis, {
  set: async (k: string, value: string, ...opts: unknown[]) => {
    if (opts.includes("NX") && live(k)) return null;
    const px = opts.indexOf("PX");
    kv.set(k, { value, expiresAt: px >= 0 ? Date.now() + Number(opts[px + 1]) : undefined });
    if (k.includes("mcp-oauth-refresh")) {
      lockSets.push(k);
      lockTtls.push(Number(opts[px + 1]));
    }
    return "OK";
  },
  get: async (k: string) => live(k)?.value ?? null,
  eval: async (_script: string, _n: number, k: string, owner: string) => (live(k)?.value === owner ? (kv.delete(k), 1) : 0),
});

const AS = "https://auth.example.com";
const MCP_URL = "https://crm.example.com/mcp";

beforeEach(() => {
  kv.clear();
  lockSets.length = 0;
  lockTtls.length = 0;
  sdk.refresh.mockReset();
});

async function oauthServer(workspaceId: string, cfg: Partial<McpCredentialConfig> = {}, secret: Record<string, string> | null = { access_token: "at-1", refresh_token: "rt-1", client_secret: "cs-1" }, name = "crm") {
  const [r] = await db
    .insert(credentials)
    .values({
      workspaceId,
      kind: "mcp",
      name,
      config: {
        url: MCP_URL,
        auth: "oauth",
        authServerUrl: AS,
        tokenEndpoint: `${AS}/token`,
        tokenEndpointAuthMethod: "client_secret_post",
        clientId: "cid-1",
        resource: MCP_URL,
        expiresAt: Date.now() + 3600_000,
        scope: "read",
        ...cfg,
      } satisfies McpCredentialConfig,
      secretEnc: secret ? encryptSecret(JSON.stringify(secret)) : null,
    })
    .returning();
  return r!;
}
const reread = async (id: string) => (await db.select().from(credentials).where(eq(credentials.id, id)))[0]!;

describe("external MCP servers with OAuth (worker)", () => {
  it("uses a fresh access token as a Bearer header without refreshing", async () => {
    const ws = await makeWorkspace();
    await oauthServer(ws.id);
    expect(await getExternalMcpServers(ws.id)).toEqual([{ name: "crm", url: MCP_URL, headers: { Authorization: "Bearer at-1" } }]);
    expect(sdk.refresh).not.toHaveBeenCalled();
    expect(lockSets).toEqual([]);
  });

  it("refreshes a token that expires within 5 minutes once, under the lock, for two concurrent runs", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { access_token: "at-2", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-2", scope: "read write" };
    });
    const before = Date.now();
    const [a, b] = await Promise.all([getExternalMcpServers(ws.id), getExternalMcpServers(ws.id)]);

    expect(sdk.refresh).toHaveBeenCalledTimes(1);
    for (const servers of [a, b]) expect(servers).toEqual([{ name: "crm", url: MCP_URL, headers: { Authorization: "Bearer at-2" } }]);
    const [asUrl, opts] = sdk.refresh.mock.calls[0]!;
    expect(asUrl).toBe(AS);
    expect(opts).toMatchObject({
      refreshToken: "rt-1",
      resource: MCP_URL,
      clientInformation: { client_id: "cid-1", client_secret: "cs-1", token_endpoint_auth_method: "client_secret_post" },
      metadata: { token_endpoint: `${AS}/token`, token_endpoint_auth_methods_supported: ["client_secret_post"] },
    });
    expect(typeof opts.fetchFn).toBe("function");

    const saved = await reread(row.id);
    expect(JSON.parse(decryptSecret(saved.secretEnc!))).toEqual({ access_token: "at-2", refresh_token: "rt-2", client_secret: "cs-1" });
    const cfg = saved.config as McpCredentialConfig;
    expect(cfg.expiresAt!).toBeGreaterThanOrEqual(before + 3600_000);
    expect(cfg.scope).toBe("read write");
    expect(JSON.stringify(cfg)).not.toMatch(/at-[12]|rt-[12]|cs-1/);
    // the lock is released (only by its holder) once the new token is saved
    expect(lockSets).toEqual([`wfos-test:wfos:mcp-oauth-refresh:${row.id}`]);
    expect(kv.size).toBe(0);

    // the next run uses the saved token
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-2");
    expect(sdk.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the refresh token when the server does not return a new one", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() - 1000 });
    sdk.refresh.mockImplementation(async (_as: string, o: { refreshToken: string }) => ({ refresh_token: o.refreshToken, access_token: "at-2", token_type: "Bearer" }));
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-2");
    const saved = await reread(row.id);
    expect(JSON.parse(decryptSecret(saved.secretEnc!)).refresh_token).toBe("rt-1");
    expect((saved.config as McpCredentialConfig).expiresAt).toBeNull(); // no expiry given: never refreshed again
  });

  it("a refused refresh marks the server needsReauth and leaves it out, without breaking the others", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    await db.insert(credentials).values({ workspaceId: ws.id, kind: "mcp", name: "docs", config: { url: "https://docs.example.com/mcp" }, secretEnc: encryptSecret("tok") });
    sdk.refresh.mockRejectedValue(Object.assign(new Error("refresh token revoked"), { errorCode: "invalid_grant" }));

    const servers = await getExternalMcpServers(ws.id);
    expect(servers.map((s) => s.name)).toEqual(["docs"]);
    const cfg = (await reread(row.id)).config as McpCredentialConfig;
    expect(cfg.needsReauth).toBe(true);
    expect(cfg.clientId).toBe("cid-1"); // the rest of the config is kept
    expect(kv.size).toBe(0);

    // until the owner reconnects, the server is skipped without trying again
    expect((await getExternalMcpServers(ws.id)).map((s) => s.name)).toEqual(["docs"]);
    expect(sdk.refresh).toHaveBeenCalledTimes(1);
  });

  it("an outage at the token endpoint keeps the still-valid token and does not ask for a reconnect", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockRejectedValue(new Error("fetch failed"));
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-1");
    expect((await reread(row.id)).config).not.toHaveProperty("needsReauth");

    // once it has expired, the server is left out of the run (still without needsReauth: the next run tries again)
    await db.update(credentials).set({ config: { ...(row.config as McpCredentialConfig), expiresAt: Date.now() - 1 } }).where(eq(credentials.id, row.id));
    sdk.refresh.mockRejectedValue(Object.assign(new Error("HTTP 503"), { errorCode: "server_error" }));
    expect(await getExternalMcpServers(ws.id)).toEqual([]);
    expect((await reread(row.id)).config).not.toHaveProperty("needsReauth");
  });

  it("an expired token without a refresh token needs a reconnect", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() - 1000 }, { access_token: "at-1" });
    expect(await getExternalMcpServers(ws.id)).toEqual([]);
    expect(sdk.refresh).not.toHaveBeenCalled();
    expect((await reread(row.id)).config).toMatchObject({ needsReauth: true });
  });

  it("waits for another worker's refresh instead of refreshing again", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    // another worker holds the lock and saves its refreshed token shortly after
    kv.set(`wfos-test:wfos:mcp-oauth-refresh:${row.id}`, { value: "someone-else", expiresAt: Date.now() + 30_000 });
    setTimeout(() => {
      void db
        .update(credentials)
        .set({
          secretEnc: encryptSecret(JSON.stringify({ access_token: "at-other", refresh_token: "rt-other", client_secret: "cs-1" })),
          config: { ...(row.config as McpCredentialConfig), expiresAt: Date.now() + 3600_000 },
        })
        .where(eq(credentials.id, row.id))
        .then(() => {});
    }, 300);
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-other");
    expect(sdk.refresh).not.toHaveBeenCalled();
    // someone else's lock is left alone
    expect(kv.get(`wfos-test:wfos:mcp-oauth-refresh:${row.id}`)?.value).toBe("someone-else");
  });
});

describe("OAuth refresh races and destinations", () => {
  const lockKey = (id: string) => `wfos-test:wfos:mcp-oauth-refresh:${id}`;
  /** what an owner's reconnect writes: a new secret (and a fresh expiry) */
  const reconnect = (row: { id: string; config: unknown }) =>
    db
      .update(credentials)
      .set({
        secretEnc: encryptSecret(JSON.stringify({ access_token: "at-reconnected", refresh_token: "rt-new", client_secret: "cs-1" })),
        config: { ...(row.config as McpCredentialConfig), expiresAt: Date.now() + 3600_000 },
      })
      .where(eq(credentials.id, row.id));

  it("the lock outlives three token-request timeouts", async () => {
    expect(REFRESH_LOCK_MS).toBeGreaterThanOrEqual(3 * MCP_OAUTH_FETCH_TIMEOUT_MS);
    const ws = await makeWorkspace();
    await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockResolvedValue({ access_token: "at-2", token_type: "Bearer", expires_in: 3600 });
    await getExternalMcpServers(ws.id);
    expect(lockTtls).toEqual([REFRESH_LOCK_MS]);
  });

  it("token requests go only to public addresses or the MCP server's own host", async () => {
    const ws = await makeWorkspace();
    await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockResolvedValue({ access_token: "at-2", token_type: "Bearer", expires_in: 3600 });
    await getExternalMcpServers(ws.id);
    const fetchFn = sdk.refresh.mock.calls[0]![1].fetchFn as (u: string, init?: RequestInit) => Promise<Response>;
    for (const u of ["http://169.254.169.254/latest/meta-data", "http://10.0.0.1/token", "http://127.0.0.1:8080/token", "http://[::1]/token", "file:///etc/passwd"]) {
      await expect(fetchFn(u)).rejects.toThrow(/refused/);
    }
    const seen: string[] = [];
    const blocked = globalThis.fetch;
    globalThis.fetch = (async (u: unknown) => (seen.push(String(u)), new Response("{}", { status: 200 }))) as typeof fetch;
    try {
      // the configured MCP host is allowed without a DNS check (an Owner may run it on a private network)
      expect((await fetchFn("https://crm.example.com/oauth/token", { method: "POST" })).status).toBe(200);
    } finally {
      globalThis.fetch = blocked;
    }
    expect(seen).toEqual(["https://crm.example.com/oauth/token"]);
  });

  it("an owner's reconnect during the refresh wins: the refreshed token is not saved over it", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockImplementation(async () => {
      await reconnect(row);
      return { access_token: "at-2", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-2" };
    });
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-reconnected");
    expect(JSON.parse(decryptSecret((await reread(row.id)).secretEnc!))).toMatchObject({ access_token: "at-reconnected", refresh_token: "rt-new" });
  });

  it("a refused refresh does not mark a server that was reconnected meanwhile", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockImplementation(async () => {
      await reconnect(row);
      throw Object.assign(new Error("refresh token revoked"), { errorCode: "invalid_grant" });
    });
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-reconnected");
    expect((await reread(row.id)).config).not.toHaveProperty("needsReauth");
  });

  it("a refused refresh whose lock was lost meanwhile does not mark the server and leaves the new holder's lock", async () => {
    const ws = await makeWorkspace();
    const row = await oauthServer(ws.id, { expiresAt: Date.now() + 60_000 });
    sdk.refresh.mockImplementation(async () => {
      // our lock expired and another worker took it (it may have rotated the refresh token already)
      kv.set(lockKey(row.id), { value: "someone-else", expiresAt: Date.now() + 30_000 });
      throw Object.assign(new Error("refresh token revoked"), { errorCode: "invalid_grant" });
    });
    expect((await getExternalMcpServers(ws.id))[0]!.headers.Authorization).toBe("Bearer at-1"); // still valid
    expect((await reread(row.id)).config).not.toHaveProperty("needsReauth");
    expect(kv.get(lockKey(row.id))?.value).toBe("someone-else");
  });
});

describe("external MCP servers that are not ready", () => {
  it("skips disabled servers and servers whose secret is empty, for both auth kinds", async () => {
    const ws = await makeWorkspace();
    const plain = (name: string, config: Record<string, unknown>, secretEnc: string | null) =>
      db.insert(credentials).values({ workspaceId: ws.id, kind: "mcp", name, config: { url: `https://${name}.example.com/mcp`, ...config }, secretEnc });
    await plain("ready", {}, encryptSecret("tok"));
    await plain("public", {}, null); // added without a token on purpose: a server that needs none
    await plain("off", { disabled: true }, encryptSecret("tok"));
    await plain("imported", {}, encryptSecret(""));
    await plain("imported-off", { disabled: true }, null);
    await oauthServer(ws.id, { disabled: true }, undefined, "oauth-off");
    await oauthServer(ws.id, {}, null, "oauth-empty");
    await db.insert(credentials).values({ workspaceId: ws.id, kind: "mcp", name: "oauth-junk", config: { url: MCP_URL, auth: "oauth" }, secretEnc: encryptSecret("not json") });
    await oauthServer(ws.id, {}, undefined, "oauth-ok");

    const servers = await getExternalMcpServers(ws.id);
    expect(servers.map((s) => s.name).sort()).toEqual(["oauth-ok", "public", "ready"]);
    expect(servers.find((s) => s.name === "public")!.headers).toEqual({});
    expect(servers.find((s) => s.name === "ready")!.headers).toEqual({ Authorization: "Bearer tok" });
    expect(sdk.refresh).not.toHaveBeenCalled();
  });
});
