import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, credentials, db, members, users, workspaces } from "@wfos/db";
import { mcpOAuthFetch, type Role } from "@wfos/shared";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listServers, POST as addServer } from "@/app/api/settings/mcp/route";
import { GET as callback } from "@/app/api/settings/mcp/oauth/callback/route";
import { POST as start } from "@/app/api/settings/mcp/oauth/start/route";
import { getMcpServer } from "@/lib/server/mcp";
import { oauthErrorTag, sameSite } from "@/lib/server/mcp-oauth";
import { call, jar, resetBrowser } from "./browser";

// no network: every host resolves through the fake DNS (public unless it is a *.private.test host)
vi.mock("node:dns/promises", async (orig) => (await import("./fake-dns")).dnsModule(orig as () => Promise<typeof import("node:dns/promises")>));

/** Redis for the sign-in state: SET with EX, GET, GETDEL; a key past its TTL is gone. */
const store = vi.hoisted(() => new Map<string, { value: string; ttlSec?: number; expiresAt?: number }>());
vi.mock("@/lib/server/queue", async () => {
  const m = (await import("./browser")).queueModule;
  const live = (k: string) => {
    const e = store.get(k);
    if (e?.expiresAt !== undefined && e.expiresAt <= Date.now()) store.delete(k);
    return store.get(k);
  };
  return {
    ...m,
    redis: () => ({
      ...m.redis(),
      set: async (k: string, value: string, ...opts: unknown[]) => {
        if (opts.includes("NX") && live(k)) return null;
        const i = opts.indexOf("EX");
        const px = opts.indexOf("PX");
        const ttlSec = i >= 0 ? Number(opts[i + 1]) : px >= 0 ? Number(opts[px + 1]) / 1000 : undefined;
        store.set(k, { value, ttlSec, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
        return "OK";
      },
      // the lock release script: delete KEYS[1] only while it holds ARGV[1]
      eval: async (_script: string, _n: number, k: string, v: string) => (live(k)?.value === v ? (store.delete(k), 1) : 0),
      get: async (k: string) => live(k)?.value ?? null,
      getdel: async (k: string) => {
        const v = live(k)?.value ?? null;
        store.delete(k);
        return v;
      },
    }),
  };
});

const MCP_URL = "https://mcp.example.com/mcp";
const AS = "https://auth.example.com";
const REDIRECT = "http://localhost:3010/api/settings/mcp/oauth/callback";

/** A fake MCP server + authorization server behind fetch. Every request is recorded. */
const net = {
  requests: [] as { method: string; url: string; body: string }[],
  registration: { status: 201, body: { client_id: "cid-1", client_secret: "csecret-1", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" } as unknown },
  token: { status: 200, body: { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read write" } as unknown },
  oauth: true,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
  net.requests.push({ method, url: url.href, body });
  if (!net.oauth) return json(404, { error: "not_found" });
  if (url.href === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
    return json(200, { resource: MCP_URL, authorization_servers: [AS], scopes_supported: ["read", "write"] });
  }
  if (url.href === `${AS}/.well-known/oauth-authorization-server`) {
    return json(200, {
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: `${AS}/token`,
      registration_endpoint: `${AS}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    });
  }
  if (url.href === `${AS}/register` && method === "POST") return json(net.registration.status, net.registration.body);
  if (url.href === `${AS}/token` && method === "POST") return json(net.token.status, net.token.body);
  return json(404, { error: "not_found" });
}

beforeEach(() => {
  resetBrowser();
  store.clear();
  net.requests.length = 0;
  net.oauth = true;
  net.registration.status = 201;
  net.token.status = 200;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function member(workspaceId: string, role: Role) {
  const email = `m-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "M", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role });
  return { email, id: u!.id };
}
async function signIn(email: string) {
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
}
async function signedIn(role: Role) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const m = await member(ws!.id, role);
  await signIn(m.email);
  return { ws: ws!, user: m };
}

async function startSignIn(name = "crm", url = MCP_URL) {
  const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name, url });
  expect(r.status).toBe(200);
  const authorizeUrl = new URL(String(r.json.authorizeUrl));
  return { authorizeUrl, state: authorizeUrl.searchParams.get("state")! };
}

async function back(params: Record<string, string>) {
  const res = await callback(new NextRequest(`http://localhost:3010/api/settings/mcp/oauth/callback?${new URLSearchParams(params)}`));
  expect([302, 303, 307]).toContain(res.status);
  return new URL(res.headers.get("location")!);
}
const outcome = (u: URL) => u.searchParams.get("mcp");

const row = async (workspaceId: string, name = "crm") =>
  (await db.select().from(credentials).where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, "mcp"), eq(credentials.name, name))))[0];

describe("POST /api/settings/mcp/oauth/start", () => {
  it("registers a client, keeps the state 10 minutes (encrypted) and answers a PKCE S256 authorize URL", async () => {
    const { ws, user } = await signedIn("OWNER");
    const { authorizeUrl, state } = await startSignIn();

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${AS}/authorize`);
    const p = authorizeUrl.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("cid-1");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("resource")).toBe(MCP_URL);
    expect(p.get("scope")).toBe("read write");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes

    const reg = net.requests.find((r) => r.url === `${AS}/register`)!;
    expect(JSON.parse(reg.body)).toMatchObject({ client_name: "Workforce OS", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"] });

    const key = `wfos-test:wfos:mcp-oauth:${state}`;
    const entry = store.get(key)!;
    expect(entry.ttlSec).toBe(600);
    // the client secret and verifier are not readable from Redis
    expect(entry.value).not.toContain("csecret-1");
    const pending = JSON.parse(decryptSecret(entry.value));
    expect(pending).toMatchObject({ workspaceId: ws.id, userId: user.id, name: "crm", url: MCP_URL, resource: MCP_URL, authServerUrl: AS });
    expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pending.clientInformation.client_id).toBe("cid-1");
    expect(pending.authServerMetadata.token_endpoint).toBe(`${AS}/token`);
    // nothing is saved before the callback
    expect(await row(ws.id)).toBeUndefined();
  });

  it("is for Owners only and checks the name and URL before any request", async () => {
    await signedIn("ADMIN");
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: MCP_URL });
    expect([r.status, r.json.code]).toEqual([403, "role_required"]);

    await signedIn("OWNER");
    const bad = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "Bad__Name", url: MCP_URL });
    expect([bad.status, bad.json.code]).toEqual([400, "mcp_invalid_name"]);
    const file = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: "file:///etc/passwd" });
    expect([file.status, file.json.code]).toEqual([400, "mcp_invalid_url"]);
    expect(net.requests).toEqual([]);
  });

  it("a server without OAuth (no metadata, no registration) is a 502 with a code", async () => {
    await signedIn("OWNER");
    net.oauth = false;
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: MCP_URL });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("mcp_oauth_registration_failed");
    expect(typeof r.json.error).toBe("string");
    expect(store.size).toBe(0);
  });

  it("mcpOAuthFetch: http(s) only, never follows by itself, refuses a redirect to another origin or scheme", async () => {
    const seen: RequestInit[] = [];
    const base = async (u: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      const to = new URL(String(u)).searchParams.get("to");
      return to ? new Response(null, { status: 302, headers: { location: to } }) : new Response("ok");
    };
    const f = mcpOAuthFetch(base);
    await expect(f("ftp://mcp.example.com/x")).rejects.toThrow(/non-http/);
    await expect(f("https://mcp.example.com/a?to=https://evil.example.net/b")).rejects.toThrow(/another origin/);
    await expect(f("https://mcp.example.com/a?to=javascript:alert(1)")).rejects.toThrow(/another origin/);
    // a same-origin redirect is handed back for the SDK to follow (through this fetch again)
    expect((await f("https://mcp.example.com/a?to=/b")).status).toBe(302);
    expect((await f("https://mcp.example.com/ok")).status).toBe(200);
    expect(seen.every((i) => i.redirect === "manual" && i.signal instanceof AbortSignal)).toBe(true);
  });

  it("the helpers' fetch refuses a redirect to another origin", async () => {
    await signedIn("OWNER");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        const url = new URL(String(input));
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
        return fakeFetch(input, init);
      }),
    );
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: MCP_URL });
    // the protected resource metadata could not be read: the legacy fallback (MCP origin as the auth server) has none
    expect(r.status).toBe(502);
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string | URL][] } }).mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });
});

describe("GET /api/settings/mcp/oauth/callback", () => {
  it("saves the server with encrypted tokens and only non-secret config, audits it, and redirects to Integrations", async () => {
    const { ws } = await signedIn("OWNER");
    const { state } = await startSignIn();
    const pending = JSON.parse(decryptSecret(store.get(`wfos-test:wfos:mcp-oauth:${state}`)!.value));
    const before = Date.now();

    const loc = await back({ code: "code-1", state });
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("tab")).toBe("integrations");
    expect(outcome(loc)).toBe("connected");

    const tokenReq = new URLSearchParams(net.requests.find((r) => r.url === `${AS}/token`)!.body);
    expect(tokenReq.get("grant_type")).toBe("authorization_code");
    expect(tokenReq.get("code")).toBe("code-1");
    expect(tokenReq.get("code_verifier")).toBe(pending.codeVerifier);
    expect(tokenReq.get("redirect_uri")).toBe(REDIRECT);
    expect(tokenReq.get("resource")).toBe(MCP_URL);
    expect(tokenReq.get("client_secret")).toBe("csecret-1"); // client_secret_post, as registered

    const saved = (await row(ws.id))!;
    const cfg = saved.config as Record<string, unknown>;
    expect(cfg).toMatchObject({ url: MCP_URL, auth: "oauth", tokenEndpoint: `${AS}/token`, clientId: "cid-1", resource: MCP_URL, scope: "read write", tokenEndpointAuthMethod: "client_secret_post" });
    expect(cfg.expiresAt as number).toBeGreaterThanOrEqual(before + 3600_000 - 1000);
    expect(cfg.expiresAt as number).toBeLessThanOrEqual(Date.now() + 3600_000);
    const plainConfig = JSON.stringify(cfg);
    for (const secret of ["at-1", "rt-1", "csecret-1"]) {
      expect(plainConfig).not.toContain(secret);
      expect(saved.secretEnc).not.toContain(secret);
    }
    expect(JSON.parse(decryptSecret(saved.secretEnc!))).toEqual({ access_token: "at-1", refresh_token: "rt-1", client_secret: "csecret-1" });

    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "credential.mcp_oauth_connected")));
    expect(entry?.targetId).toBe("crm");
    expect(JSON.stringify(entry?.details)).not.toContain("at-1");

    const list = await call(listServers, "GET", "/api/settings/mcp");
    expect(list.json.servers).toEqual([expect.objectContaining({ name: "crm", auth: "oauth", needsReconnect: false, tokenSet: true })]);
    expect(await getMcpServer(ws.id, "crm")).toEqual({ name: "crm", url: MCP_URL, headers: { Authorization: "Bearer at-1" }, allowHosts: ["mcp.example.com"] });
  });

  it("refuses an unknown, an expired and a reused state", async () => {
    const { ws } = await signedIn("OWNER");
    expect(outcome(await back({ code: "c", state: "x".repeat(43) }))).toBe("invalid_state");
    expect(outcome(await back({ code: "c" }))).toBe("invalid_state");

    const expired = await startSignIn();
    store.get(`wfos-test:wfos:mcp-oauth:${expired.state}`)!.expiresAt = Date.now() - 1;
    expect(outcome(await back({ code: "c", state: expired.state }))).toBe("invalid_state");

    const { state } = await startSignIn();
    expect(outcome(await back({ code: "c", state }))).toBe("connected");
    net.token.body = { access_token: "at-2", token_type: "Bearer" };
    expect(outcome(await back({ code: "c", state }))).toBe("invalid_state");
    expect(JSON.parse(decryptSecret((await row(ws.id))!.secretEnc!)).access_token).toBe("at-1");
    expect(net.requests.filter((r) => r.url === `${AS}/token`)).toHaveLength(1);
    net.token.body = { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read write" };
  });

  it("only the owner who started it can finish it (a stray callback does not burn the state)", async () => {
    const { ws, user } = await signedIn("OWNER");
    const other = await member(ws.id, "OWNER");
    const { state } = await startSignIn();

    await signIn(other.email);
    expect(outcome(await back({ code: "c", state }))).toBe("invalid_state");
    expect(await row(ws.id)).toBeUndefined();

    jar.clear();
    const res = await callback(new NextRequest(`http://localhost:3010/api/settings/mcp/oauth/callback?code=c&state=${state}`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");

    await signIn(user.email);
    expect(outcome(await back({ code: "c", state }))).toBe("connected");
    expect((await row(ws.id))?.config).toMatchObject({ auth: "oauth" });
  });

  it("a sign-in cancelled on the server consumes the state and saves nothing", async () => {
    const { ws } = await signedIn("OWNER");
    const { state } = await startSignIn();
    expect(outcome(await back({ error: "access_denied", state }))).toBe("denied");
    expect(store.size).toBe(0);
    expect(await row(ws.id)).toBeUndefined();
  });

  it("a refused code exchange redirects with failed", async () => {
    const { ws } = await signedIn("OWNER");
    const { state } = await startSignIn();
    net.token.status = 400;
    net.token.body = { error: "invalid_grant", error_description: "bad code" };
    expect(outcome(await back({ code: "c", state }))).toBe("failed");
    expect(await row(ws.id)).toBeUndefined();
    net.token.body = { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read write" };
  });
});

describe("OAuth servers in the web", () => {
  async function oauthServer(workspaceId: string, over: Record<string, unknown> = {}) {
    await db.insert(credentials).values({
      workspaceId,
      kind: "mcp",
      name: "crm",
      config: { url: MCP_URL, auth: "oauth", clientId: "cid-1", tokenEndpoint: `${AS}/token`, expiresAt: Date.now() + 3600_000, ...over },
      secretEnc: encryptSecret(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1" })),
    });
  }

  it("an expired token without a way to refresh it, or a refused one, is a 'needs reconnect' error", async () => {
    const { ws } = await signedIn("OWNER");
    await db.insert(credentials).values({
      workspaceId: ws.id,
      kind: "mcp",
      name: "crm",
      config: { url: MCP_URL, auth: "oauth", tokenEndpoint: `${AS}/token`, expiresAt: Date.now() - 1000 },
      secretEnc: encryptSecret(JSON.stringify({ access_token: "at-1" })), // no refresh token, no client
    });
    await expect(getMcpServer(ws.id, "crm")).rejects.toMatchObject({ status: 409, extra: { code: "mcp_needs_reconnect", name: "crm" } });
    expect(net.requests).toEqual([]);
    expect((await row(ws.id))!.config).toMatchObject({ needsReauth: true });
    const list = await call(listServers, "GET", "/api/settings/mcp");
    expect(list.json.servers).toEqual([expect.objectContaining({ auth: "oauth", needsReconnect: true, disabled: false })]);

    await db.update(credentials).set({ config: { url: MCP_URL, auth: "oauth", expiresAt: Date.now() + 3600_000, needsReauth: true } }).where(eq(credentials.workspaceId, ws.id));
    await expect(getMcpServer(ws.id, "crm")).rejects.toMatchObject({ status: 409, extra: { code: "mcp_needs_reconnect" } });
  });

  it("an expired but refreshable token is shown as fine and refreshed on use, under the worker's lock, compare-and-set", async () => {
    const { ws } = await signedIn("OWNER");
    await oauthServer(ws.id, { expiresAt: Date.now() - 1000 });
    const list = await call(listServers, "GET", "/api/settings/mcp");
    expect(list.json.servers).toEqual([expect.objectContaining({ auth: "oauth", needsReconnect: false })]);
    net.token.body = { access_token: "at-2", token_type: "Bearer", expires_in: 3600 };
    const server = await getMcpServer(ws.id, "crm");
    expect(server?.headers).toEqual({ Authorization: "Bearer at-2" });
    const req = new URLSearchParams(net.requests.find((r) => r.url === `${AS}/token`)!.body);
    expect(req.get("grant_type")).toBe("refresh_token");
    expect(req.get("refresh_token")).toBe("rt-1");
    const saved = (await row(ws.id))!;
    // the refresh token is kept when the server sends no new one
    expect(JSON.parse(decryptSecret(saved.secretEnc!))).toEqual({ access_token: "at-2", refresh_token: "rt-1" });
    expect((saved.config as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    // the lock is released
    expect([...store.keys()].some((k) => k.includes("mcp-oauth-refresh"))).toBe(false);
    net.token.body = { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read write" };
  });

  it("a refused refresh marks the server for a reconnect; an outage with an expired token says retry", async () => {
    const { ws } = await signedIn("OWNER");
    await oauthServer(ws.id, { expiresAt: Date.now() - 1000 });
    net.token.status = 503;
    net.token.body = { error: "temporarily_unavailable" };
    await expect(getMcpServer(ws.id, "crm")).rejects.toMatchObject({ status: 409, extra: { code: "mcp_oauth_refreshing" } });
    expect((await row(ws.id))!.config).not.toHaveProperty("needsReauth");
    net.token.status = 400;
    net.token.body = { error: "invalid_grant", error_description: "refresh token revoked <script>" };
    await expect(getMcpServer(ws.id, "crm")).rejects.toMatchObject({ status: 409, extra: { code: "mcp_needs_reconnect" } });
    expect((await row(ws.id))!.config).toMatchObject({ needsReauth: true });
    net.token.body = { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read write" };
  });

  it("while a run holds the refresh lock, the web waits and uses what it saved (no second refresh)", async () => {
    const { ws } = await signedIn("OWNER");
    await oauthServer(ws.id, { expiresAt: Date.now() - 1000 });
    const [cred] = await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id));
    store.set(`wfos-test:wfos:mcp-oauth-refresh:${cred!.id}`, { value: "worker-lock" });
    const pending = getMcpServer(ws.id, "crm");
    await new Promise((r) => setTimeout(r, 300));
    await db
      .update(credentials)
      .set({ secretEnc: encryptSecret(JSON.stringify({ access_token: "at-worker", refresh_token: "rt-2" })), config: { ...(cred!.config as object), expiresAt: Date.now() + 3600_000 } })
      .where(eq(credentials.id, cred!.id));
    expect((await pending)?.headers).toEqual({ Authorization: "Bearer at-worker" });
    expect(net.requests.filter((r) => r.url === `${AS}/token`)).toHaveLength(0);
    expect(store.get(`wfos-test:wfos:mcp-oauth-refresh:${cred!.id}`)?.value).toBe("worker-lock");
  });

  it("an imported (disabled) slot is never contacted: 409 mcp_server_disabled, and listed as disabled", async () => {
    const { ws } = await signedIn("OWNER");
    await db.insert(credentials).values({ workspaceId: ws.id, kind: "mcp", name: "crm", config: { url: "http://10.0.0.5/mcp", disabled: true }, secretEnc: null });
    await expect(getMcpServer(ws.id, "crm")).rejects.toMatchObject({ status: 409, extra: { code: "mcp_server_disabled", name: "crm" } });
    const list = await call(listServers, "GET", "/api/settings/mcp");
    expect(list.json.servers).toEqual([expect.objectContaining({ name: "crm", disabled: true })]);
    expect(net.requests).toEqual([]);
  });

  it("a reconnect reuses the registered client", async () => {
    const { ws } = await signedIn("OWNER");
    const first = await startSignIn();
    expect(outcome(await back({ code: "c", state: first.state }))).toBe("connected");
    net.requests.length = 0;
    const again = await startSignIn();
    expect(again.authorizeUrl.searchParams.get("client_id")).toBe("cid-1");
    expect(net.requests.some((r) => r.url === `${AS}/register`)).toBe(false);
    expect(outcome(await back({ code: "c", state: again.state }))).toBe("connected");
    expect(new URLSearchParams(net.requests.find((r) => r.url === `${AS}/token`)!.body).get("client_secret")).toBe("csecret-1");
    expect((await row(ws.id))?.config).toMatchObject({ clientId: "cid-1" });
  });

  it("replacing an OAuth server with a plain one without a token drops the OAuth tokens", async () => {
    const { ws } = await signedIn("OWNER");
    await oauthServer(ws.id);
    expect((await call(addServer, "POST", "/api/settings/mcp", { name: "crm", url: MCP_URL })).status).toBe(200);
    const saved = (await row(ws.id))!;
    expect(saved.secretEnc).toBeNull();
    expect(saved.config).toEqual({ url: MCP_URL });
  });
});

describe("OAuth start: what the Owner confirms, and where the server may go", () => {
  it("answers the authorization server's host, the scopes and whether it is on the MCP server's site", async () => {
    await signedIn("OWNER");
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: MCP_URL });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ authorizationServerHost: "auth.example.com", scopes: ["read", "write"], sameSite: true });
    expect(String(r.json.authorizeUrl).startsWith(`${AS}/authorize?`)).toBe(true);
  });

  it("flags an authorization server on another site", async () => {
    await signedIn("OWNER");
    const other = "https://login.other-idp.example.net";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.href === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") return json(200, { resource: MCP_URL, authorization_servers: [other] });
        if (url.href === `${other}/.well-known/oauth-authorization-server`) {
          return json(200, { issuer: other, authorization_endpoint: `${other}/authorize`, token_endpoint: `${other}/token`, registration_endpoint: `${other}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
        }
        if (url.href === `${other}/register`) return json(201, { client_id: "cid-x", redirect_uris: [REDIRECT] });
        return fakeFetch(input, init);
      }),
    );
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: MCP_URL });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ authorizationServerHost: "login.other-idp.example.net", scopes: [], sameSite: false });
  });

  it("never fetches an authorization server that resolves to a private address (the MCP host itself is allowed)", async () => {
    await signedIn("OWNER");
    const evil = "https://auth.private.test";
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") return json(200, { resource: MCP_URL, authorization_servers: [evil] });
      return fakeFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: MCP_URL });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("mcp_oauth_discovery_failed");
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.includes("private.test"))).toBe(false);
  });

  it("an MCP server on a private address the Owner typed is allowed (its own host only)", async () => {
    await signedIn("OWNER");
    const internal = "https://mcp.private.test/mcp";
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => json(404, { error: "not_found" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await call(start, "POST", "/api/settings/mcp/oauth/start", { name: "crm", url: internal });
    expect(r.status).toBe(502); // no OAuth there, but it was asked
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.startsWith("https://mcp.private.test/"))).toBe(true);
  });

  it.each(["oauth", "tools"])("reserves the name %s", async (name) => {
    const { ws } = await signedIn("OWNER");
    for (const r of [
      await call(start, "POST", "/api/settings/mcp/oauth/start", { name, url: MCP_URL }),
      await call(addServer, "POST", "/api/settings/mcp", { name, url: MCP_URL }),
    ]) {
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("mcp_reserved_name");
    }
    expect(net.requests).toEqual([]);
    expect(await row(ws.id, name)).toBeUndefined();
  });

  it("sameSite compares registrable domains (approximately)", () => {
    expect(sameSite("auth.example.com", "mcp.example.com")).toBe(true);
    expect(sameSite("example.com", "mcp.example.com")).toBe(true);
    expect(sameSite("login.idp.net", "mcp.example.com")).toBe(false);
    expect(sameSite("auth.acme.co.uk", "mcp.acme.co.uk")).toBe(true);
    expect(sameSite("auth.evil.co.uk", "mcp.acme.co.uk")).toBe(false);
    expect(sameSite("10.0.0.1", "10.0.0.2")).toBe(false);
  });

  it("logs the OAuth error code and class, never the remote text", () => {
    expect(oauthErrorTag(Object.assign(new Error("invalid_grant: <html>stack trace</html>"), { name: "InvalidGrantError", errorCode: "invalid_grant" }))).toEqual({ errorCode: "invalid_grant", errorClass: "InvalidGrantError" });
    expect(oauthErrorTag(new TypeError("fetch failed to 10.0.0.5"))).toEqual({ errorClass: "TypeError" });
    expect(oauthErrorTag({ name: "x y <z>", errorCode: "a b" })).toEqual({ errorClass: "Error" });
  });
});
