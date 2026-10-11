import { describe, expect, it, vi } from "vitest";
import { credentials, db } from "@wfos/db";
import { encryptSecret } from "@wfos/shared/server";
import { makeWorkspace } from "./fixtures";

/** The MCP SDK client and transport are replaced: no network, the transport options are recorded. */
const sdk = vi.hoisted(() => ({ transports: [] as { url: URL; opts: Record<string, unknown> }[] }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts: Record<string, unknown>) {
      sdk.transports.push({ url, opts });
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async callTool() {
      return { content: [{ type: "text", text: "created" }] };
    }
    async close() {}
  },
}));

const { callExternalMcpTool, noAutoRedirectFetch } = await import("../src/tools/actions");

describe("external MCP tool calls (worker)", () => {
  it("never let the runtime follow a redirect: same-origin policy and a manual-redirect fetch, auth header kept", async () => {
    const ws = await makeWorkspace();
    await db.insert(credentials).values({ workspaceId: ws.id, kind: "mcp", name: "crm", config: { url: "https://crm.example.com/mcp" }, secretEnc: encryptSecret("tok") });
    const r = await callExternalMcpTool(ws.id, "crm", "create_lead", { name: "Ana" });
    expect(r).toEqual({ ok: true, summary: "created" });
    expect(sdk.transports).toHaveLength(1);
    const { url, opts } = sdk.transports[0]!;
    expect(url.href).toBe("https://crm.example.com/mcp");
    expect(opts).toMatchObject({ redirectPolicy: "same-origin", requestInit: { headers: { Authorization: "Bearer tok" } } });
    expect(opts.fetch).toBe(noAutoRedirectFetch);
  });

  it("noAutoRedirectFetch passes redirect: manual (keeping the caller's init)", async () => {
    const calls: [unknown, RequestInit | undefined][] = [];
    const blocked = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => (calls.push([u, init]), new Response(null, { status: 302, headers: { location: "https://evil.example/" } }))) as typeof fetch;
    try {
      const res = await noAutoRedirectFetch("https://crm.example.com/mcp", { method: "POST", redirect: "follow", headers: { a: "b" } });
      expect(res.status).toBe(302);
    } finally {
      globalThis.fetch = blocked;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ method: "POST", redirect: "manual", headers: { a: "b" } });
  });
});
