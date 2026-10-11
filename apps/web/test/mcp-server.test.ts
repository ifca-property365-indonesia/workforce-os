import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { apiTokens, approvals, auditLog, db, employees, members, messages, tasks, teamMembers, teams, users, workspaces } from "@wfos/db";
import type { Role } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { GET as listTokens, POST as createToken } from "@/app/api/me/api-tokens/route";
import { DELETE as revokeToken } from "@/app/api/me/api-tokens/[id]/route";
import { DELETE as mcpDelete, GET as mcpGet, POST as mcpPost } from "@/app/api/mcp/route";
import { API_TOKEN_RATE_PER_MIN, MCP_IP_RATE_PER_MIN, MCP_WAIT_CONCURRENCY_PER_TOKEN } from "@/lib/server/api-token";
import { DELETE as removeMember } from "@/app/api/members/route";
import { POST as resetPassword } from "@/app/api/members/reset-password/route";
import { POST as changePassword } from "@/app/api/me/password/route";
import { createSessionToken } from "@/lib/server/auth";
import { MCP_TOOL_NAMES } from "@/lib/server/mcp-server";
import { setStepUp } from "@/lib/server/twofactor";
import { call, callWithParams, jar, queueModule, resetBrowser } from "./browser";

beforeEach(() => {
  resetBrowser();
  queueModule.q.task.mockClear();
  queueModule.q.chat.mockClear();
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m", persona: "x".repeat(1000) }).returning();
  const [budi] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Budi", role: "Sales", model: "m" }).returning();
  const [team] = await db.insert(teams).values({ workspaceId: ws!.id, name: "Squad", leadId: emp!.id }).returning();
  await db.insert(teamMembers).values([
    { teamId: team!.id, employeeId: emp!.id },
    { teamId: team!.id, employeeId: budi!.id },
  ]);
  return { ws: ws!, emp: emp!, budi: budi!, team: team! };
}

/** A user in `workspaceId` with that role; with 2FA unless told otherwise. Signs the "browser" in as them. */
async function member(workspaceId: string, role: Role, opts: { twoFactor?: boolean } = {}) {
  const [u] = await db
    .insert(users)
    .values({ email: `u-${randomUUID().slice(0, 8)}@test.local`, name: "U", totpSecretEnc: opts.twoFactor === false ? null : encryptSecret("JBSWY3DPEHPK3PXP") })
    .returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role });
  await signIn(u!.id, workspaceId);
  return u!;
}

async function signIn(userId: string, workspaceId: string) {
  jar.clear();
  jar.set("wfos_session", await createSessionToken(userId));
  jar.set("wfos_ws", workspaceId);
}

/** Create a token through the real endpoint (after a step-up). */
async function token(name = "laptop", expiresInDays = 90, extra: { markUntrusted?: boolean } = {}) {
  const r = await call(createToken, "POST", "/api/me/api-tokens", { name, expiresInDays, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { token: r.json.token as string, id: (r.json.apiToken as { id: string }).id };
}

async function withToken(workspaceId: string, role: Role, extra: { markUntrusted?: boolean } = {}) {
  const u = await member(workspaceId, role);
  await setStepUp(u.id);
  return { user: u, ...(await token("laptop", 90, extra)) };
}

let rpcId = 0;
async function rpc(bearer: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest("http://localhost:3010/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
  const res = await mcpPost(req);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as { result?: Record<string, unknown>; error?: { message: string; data?: { code?: string } } } };
}

async function callTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(bearer, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.json.result as { isError?: boolean; content: { type: string; text: string }[] };
  const text = result.content[0]!.text;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // error results are plain text
  }
  return { isError: !!result.isError, text, data };
}

describe("API tokens", () => {
  it("returns the token once and stores only its sha256", async () => {
    const { ws } = await workspace();
    const u = await member(ws.id, "MEMBER");
    await setStepUp(u.id);
    const { token: tok, id } = await token("Claude Code");
    expect(tok).toMatch(/^wfos_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row).toMatchObject({ workspaceId: ws.id, userId: u.id, name: "Claude Code", tokenHash: sha256(tok), prefix: tok.slice(0, 11), scopes: ["mcp"], revokedAt: null });
    expect(JSON.stringify(row)).not.toContain(tok);
    expect(row!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    const list = await call(listTokens, "GET", "/api/me/api-tokens");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(tok);
    expect(JSON.stringify(list.json)).not.toContain(sha256(tok));
    expect(list.json.mcpUrl).toBe("http://localhost:3010/api/mcp");
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "api_token.created")));
    expect(a).toMatchObject({ actorUserId: u.id, targetId: id });
  });

  it("needs 2FA and a fresh step-up to create one", async () => {
    const { ws } = await workspace();
    await member(ws.id, "MEMBER", { twoFactor: false });
    const no2fa = await call(createToken, "POST", "/api/me/api-tokens", { name: "x" });
    expect(no2fa.status).toBe(403);
    expect(no2fa.json.code).toBe("two_factor_required");
    await member(ws.id, "MEMBER");
    const noStepUp = await call(createToken, "POST", "/api/me/api-tokens", { name: "x" });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.json.code).toBe("step_up_required");
    expect((await db.select().from(apiTokens).where(eq(apiTokens.workspaceId, ws.id))).length).toBe(0);
  });

  it("every token expires within 365 days, an Owner's too; VIEWERs cannot create any", async () => {
    const { ws } = await workspace();
    const owner = await member(ws.id, "OWNER");
    await setStepUp(owner.id);
    for (const expiresInDays of [null, 366, 0]) {
      const r = await call(createToken, "POST", "/api/me/api-tokens", { name: "forever", expiresInDays });
      expect(r.status).toBe(400);
    }
    const { id } = await token("year", 365);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(365 * 86_400_000);
    expect(row!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(364 * 86_400_000);
    const viewer = await member(ws.id, "VIEWER");
    await setStepUp(viewer.id);
    expect((await call(createToken, "POST", "/api/me/api-tokens", { name: "v" })).status).toBe(403);
  });

  it("admins list and revoke everyone's tokens; members only their own", async () => {
    const { ws } = await workspace();
    const { id: memberTokenId, user: m } = await withToken(ws.id, "MEMBER");
    const { id: otherId } = await withToken(ws.id, "MEMBER");
    await signIn(m.id, ws.id);
    expect((await call(listTokens, "GET", "/api/me/api-tokens?all=1")).status).toBe(403);
    expect((await callWithParams(revokeToken, "DELETE", `/api/me/api-tokens/${otherId}`, undefined, { id: otherId })).status).toBe(404);
    const mine = await call(listTokens, "GET", "/api/me/api-tokens");
    expect((mine.json.tokens as { id: string }[]).map((t) => t.id)).toEqual([memberTokenId]);

    await member(ws.id, "ADMIN");
    const all = await call(listTokens, "GET", "/api/me/api-tokens?all=1");
    expect(all.status).toBe(200);
    expect((all.json.tokens as { id: string }[]).map((t) => t.id).sort()).toEqual([memberTokenId, otherId].sort());
    const r = await callWithParams(revokeToken, "DELETE", `/api/me/api-tokens/${otherId}`, undefined, { id: otherId });
    expect(r.status).toBe(200);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, otherId));
    expect(row!.revokedAt).not.toBeNull();
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "api_token.revoked")));
    expect(a).toMatchObject({ targetId: otherId });
  });
});

describe("API tokens end with the password or the membership", () => {
  it("a token created before the password changed is refused even if nobody revoked it", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    expect((await rpc(a.token, "tools/list")).status).toBe(200);
    await db.update(users).set({ passwordChangedAt: new Date(Date.now() + 1000) }).where(eq(users.id, a.user.id));
    const r = await rpc(a.token, "tools/list");
    expect(r.status).toBe(401);
    expect(r.json.error?.data?.code).toBe("invalid_api_token");
  });

  it("changing your own password revokes your tokens in every workspace", async () => {
    const one = await workspace();
    const two = await workspace();
    const a = await withToken(one.ws.id, "MEMBER");
    await db.insert(members).values({ workspaceId: two.ws.id, userId: a.user.id, role: "MEMBER" });
    await signIn(a.user.id, two.ws.id);
    await setStepUp(a.user.id);
    const b = await token("other ws");
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, a.user.id)); // Google-only: no current password needed
    const r = await call(changePassword, "POST", "/api/me/password", { newPassword: "a-new-password-1" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const id of [a.id, b.id]) {
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
      expect(row!.revokedAt).not.toBeNull();
    }
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, two.ws.id), eq(auditLog.action, "user.password_changed")));
    expect(log!.details).toMatchObject({ tokensRevoked: 2 });
  });

  it("an admin's password reset revokes the member's tokens", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    await member(ws.id, "ADMIN");
    const r = await call(resetPassword, "POST", "/api/members/reset-password", { userId: a.user.id });
    expect(r.status).toBe(200);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, a.id));
    expect(row!.revokedAt).not.toBeNull();
  });

  it("removing a member revokes their tokens in that workspace only", async () => {
    const one = await workspace();
    const two = await workspace();
    const a = await withToken(one.ws.id, "MEMBER");
    await db.insert(members).values({ workspaceId: two.ws.id, userId: a.user.id, role: "MEMBER" });
    await signIn(a.user.id, two.ws.id);
    await setStepUp(a.user.id);
    const b = await token("other ws");
    await member(one.ws.id, "ADMIN");
    const r = await call(removeMember, "DELETE", `/api/members?userId=${a.user.id}`);
    expect(r.status).toBe(200);
    const [gone] = await db.select().from(apiTokens).where(eq(apiTokens.id, a.id));
    const [kept] = await db.select().from(apiTokens).where(eq(apiTokens.id, b.id));
    expect(gone!.revokedAt).not.toBeNull();
    expect(kept!.revokedAt).toBeNull();
    expect((await rpc(b.token, "tools/list")).status).toBe(200);
  });
});

describe("authenticating /api/mcp", () => {
  it(`limits each client IP to ${MCP_IP_RATE_PER_MIN} requests per minute before any token lookup`, async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    for (let i = 0; i < MCP_IP_RATE_PER_MIN; i++) await queueModule.redis().incr("wfos:rl:mcp:ip:192.0.2.77");
    // even an unknown token gets 429, not 401: the database is not asked
    const unknown = await rpc(`wfos_${"b".repeat(43)}`, "tools/list", undefined, { "x-real-ip": "192.0.2.77" });
    expect(unknown.status).toBe(429);
    expect((await rpc(a.token, "tools/list", undefined, { "x-real-ip": "192.0.2.77" })).status).toBe(429);
    expect((await rpc(a.token, "tools/list", undefined, { "x-real-ip": "192.0.2.78" })).status).toBe(200);
  });

  it("rejects a missing, malformed or unknown token with a generic 401", async () => {
    for (const bearer of [null, "nope", `wfos_${"a".repeat(43)}`]) {
      const r = await rpc(bearer, "tools/list");
      expect(r.status).toBe(401);
      expect(r.json.error?.data?.code).toBe("invalid_api_token");
    }
  });

  it("rejects revoked and expired tokens, and users who left the workspace", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    expect((await rpc(a.token, "tools/list")).status).toBe(200);
    expect((await callWithParams(revokeToken, "DELETE", `/api/me/api-tokens/${a.id}`, undefined, { id: a.id })).status).toBe(200);
    expect((await rpc(a.token, "tools/list")).status).toBe(401);

    const b = await withToken(ws.id, "MEMBER");
    await db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokens.id, b.id));
    const expired = await rpc(b.token, "tools/list");
    expect(expired.status).toBe(401);
    expect(expired.json.error?.data?.code).toBe("invalid_api_token");

    const c = await withToken(ws.id, "MEMBER");
    await db.delete(members).where(and(eq(members.workspaceId, ws.id), eq(members.userId, c.user.id)));
    expect((await rpc(c.token, "tools/list")).status).toBe(401);
  });

  it("blocks an account that must change its password first", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, a.user.id));
    const r = await rpc(a.token, "tools/list");
    expect(r.status).toBe(403);
    expect(r.json.error?.data?.code).toBe("password_change_required");
  });

  it("records lastUsedAt", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    await rpc(a.token, "tools/list");
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, a.id));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it(`rate-limits each token to ${API_TOKEN_RATE_PER_MIN} requests per minute`, async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const b = await withToken(ws.id, "MEMBER");
    for (let i = 0; i < API_TOKEN_RATE_PER_MIN - 1; i++) await queueModule.redis().incr(`wfos:rl:apitoken:${a.id}`);
    expect((await rpc(a.token, "tools/list")).status).toBe(200);
    const limited = await rpc(a.token, "tools/list");
    expect(limited.status).toBe(429);
    expect(limited.json.error?.data?.code).toBe("too_many_attempts");
    expect((await rpc(b.token, "tools/list")).status).toBe(200);
  });

  it("answers GET and DELETE with 405", async () => {
    for (const handler of [mcpGet, mcpDelete]) {
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("the MCP server", () => {
  it("completes the initialize handshake with the SDK client and lists exactly the intended tools", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const fetchVia = async (url: string | URL, init?: RequestInit) => {
      const req = new NextRequest(url.toString(), init as ConstructorParameters<typeof NextRequest>[1]);
      if (req.method === "POST") return mcpPost(req);
      return req.method === "GET" ? mcpGet() : mcpDelete();
    };
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3010/api/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${a.token}` } },
      fetch: fetchVia,
    });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("workforce-os");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools.some((t) => /approve|decide|delete|kill|credential|member/i.test(t.name))).toBe(false);
    const r = (await client.callTool({ name: "list_teams", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text).teams[0]).toMatchObject({ name: "Squad", responderMode: "lead" });
    await client.close();
  });

  it("answers ping and a raw initialize request", async () => {
    const { ws } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const init = await rpc(a.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
    expect(init.status).toBe(200);
    expect(init.json.result).toMatchObject({ serverInfo: { name: "workforce-os" }, capabilities: { tools: {} } });
    expect((await rpc(a.token, "ping")).json.result).toEqual({});
  });

  it("lists employees with a short persona and scopes everything to the token's workspace", async () => {
    const mine = await workspace();
    const other = await workspace();
    const a = await withToken(mine.ws.id, "MEMBER");
    const r = await callTool(a.token, "list_employees");
    const emps = r.data.employees as { id: string; persona: string }[];
    expect(emps.map((e) => e.id).sort()).toEqual([mine.emp.id, mine.budi.id].sort());
    expect(emps.find((e) => e.id === mine.emp.id)!.persona.length).toBeLessThanOrEqual(301);

    const [foreign] = await db.insert(tasks).values({ workspaceId: other.ws.id, title: "Secret", assigneeId: other.emp.id, status: "DONE", result: "classified" }).returning();
    for (const tool of ["get_task", "wait_for_task"]) {
      const g = await callTool(a.token, tool, { taskId: foreign!.id, timeoutSec: 0 });
      expect(g.isError).toBe(true);
      expect(g.text).toBe("Task not found.");
    }
    const conv = await callTool(a.token, "get_conversation", { conversationId: randomUUID() });
    expect(conv.isError).toBe(true);
    const listed = await callTool(a.token, "list_tasks");
    expect(listed.data.tasks).toEqual([]);
    const ct = await callTool(a.token, "create_task", { title: "Steal", employeeId: other.emp.id });
    expect(ct.isError).toBe(true);
    expect(ct.text).toBe("Unknown employee");
  });

  it("create_task creates a started board task in the token's workspace and enqueues it", async () => {
    const { ws, emp } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const r = await callTool(a.token, "create_task", { title: "Monthly report", brief: "Summarise October", employeeId: emp.id });
    expect(r.isError, r.text).toBe(false);
    const taskId = r.data.taskId as string;
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row).toMatchObject({ workspaceId: ws.id, assigneeId: emp.id, source: "board", status: "QUEUED", phase: null, createdBy: a.user.id, brief: "Summarise October", dryRun: false, untrustedInput: true });
    expect(queueModule.q.task).toHaveBeenCalledWith(taskId, ws.id);
    expect(queueModule.publish).toHaveBeenCalledWith(ws.id, expect.objectContaining({ type: "task.created", taskId }));
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "task.created")));
    expect(log).toMatchObject({ actorUserId: a.user.id, actorLabel: "api-token:laptop", targetId: taskId });

    const got = await callTool(a.token, "get_task", { taskId });
    expect(got.data).toMatchObject({ id: taskId, title: "Monthly report", status: "QUEUED", pendingApprovals: 0, assignee: { id: emp.id, name: "Sari" } });
    const listed = await callTool(a.token, "list_tasks", { employeeId: emp.id });
    expect((listed.data.tasks as { id: string }[]).map((t) => t.id)).toEqual([taskId]);
  });

  it("uses the CURRENT role: a member demoted to VIEWER loses create_task and send_message", async () => {
    const { ws, emp } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    await db.update(members).set({ role: "VIEWER" }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, a.user.id)));
    const r = await callTool(a.token, "create_task", { title: "x", employeeId: emp.id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/MEMBER role/);
    expect((await callTool(a.token, "send_message", { employeeId: emp.id, text: "hi" })).isError).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.workspaceId, ws.id))).length).toBe(0);
    expect(queueModule.q.task).not.toHaveBeenCalled();
    // reads still work
    expect((await callTool(a.token, "list_employees")).isError).toBe(false);
  });

  it("send_message starts a team conversation with parsed @mentions and enqueues the chat run", async () => {
    const { ws, team, budi } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const r = await callTool(a.token, "send_message", { teamId: team.id, text: "@Budi please check the leads" });
    expect(r.isError, r.text).toBe(false);
    const { conversationId, messageId } = r.data as { conversationId: string; messageId: string };
    const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(m).toMatchObject({ conversationId, role: "user", content: "@Budi please check the leads", handledAt: null });
    expect(m!.meta.mentions).toEqual([budi.id]);
    expect(m!.meta.untrusted).toBe(true);
    expect(queueModule.q.chat).toHaveBeenCalledWith(conversationId, messageId, ws.id);
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "chat.message_sent")));
    expect(log).toMatchObject({ actorUserId: a.user.id, actorLabel: "api-token:laptop", targetType: "conversation", targetId: conversationId });
    expect(log!.details).toMatchObject({ via: "mcp", messageId, untrusted: true });

    const again = await callTool(a.token, "send_message", { conversationId, text: "and the invoices" });
    expect(again.data.conversationId).toBe(conversationId);
    await db.insert(messages).values({ conversationId, role: "assistant", content: "On it.", employeeId: budi.id });
    const conv = await callTool(a.token, "get_conversation", { conversationId, limit: 2 });
    const ms = conv.data.messages as { role: string; content: string; employee: { name: string } | null }[];
    expect(ms.map((x) => x.content)).toEqual(["and the invoices", "On it."]);
    expect(ms[1]!.employee?.name).toBe("Budi");

    expect((await callTool(a.token, "send_message", { teamId: team.id, conversationId, text: "x" })).isError).toBe(true);
  });

  it("a token created with markUntrusted off creates trusted tasks and messages", async () => {
    const { ws, emp } = await workspace();
    const a = await withToken(ws.id, "MEMBER", { markUntrusted: false });
    const [tok] = await db.select().from(apiTokens).where(eq(apiTokens.id, a.id));
    expect(tok!.markUntrusted).toBe(false);
    const t = await callTool(a.token, "create_task", { title: "Trusted", employeeId: emp.id });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t.data.taskId as string));
    expect(row!.untrustedInput).toBe(false);
    const m = await callTool(a.token, "send_message", { employeeId: emp.id, text: "hi" });
    const [msg] = await db.select().from(messages).where(eq(messages.id, m.data.messageId as string));
    expect(msg!.meta.untrusted).toBeUndefined();
  });

  it(`wait_for_task: at most ${MCP_WAIT_CONCURRENCY_PER_TOKEN} open at a time per token, and the slot is given back`, async () => {
    const { ws, emp } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const b = await withToken(ws.id, "MEMBER");
    const [running] = await db.insert(tasks).values({ workspaceId: ws.id, title: "r", assigneeId: emp.id, status: "RUNNING" }).returning();
    const key = `wfos:mcp:wait:${a.id}`;
    for (let i = 0; i < MCP_WAIT_CONCURRENCY_PER_TOKEN; i++) await queueModule.redis().incr(key); // three waits in flight
    const refused = await callTool(a.token, "wait_for_task", { taskId: running!.id, timeoutSec: 0 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Too many wait_for_task calls/);
    expect(await queueModule.redis().get(key)).toBe(String(MCP_WAIT_CONCURRENCY_PER_TOKEN));
    // another token is not affected
    expect((await callTool(b.token, "wait_for_task", { taskId: running!.id, timeoutSec: 0 })).data).toMatchObject({ status: "running" });
    await queueModule.redis().decr(key);
    expect((await callTool(a.token, "wait_for_task", { taskId: running!.id, timeoutSec: 0 })).data).toMatchObject({ status: "running" });
    expect(await queueModule.redis().get(key)).toBe(String(MCP_WAIT_CONCURRENCY_PER_TOKEN - 1));
  });

  it("wait_for_task reports finished, running and timed-out tasks", async () => {
    const { ws, emp } = await workspace();
    const a = await withToken(ws.id, "MEMBER");
    const [done] = await db.insert(tasks).values({ workspaceId: ws.id, title: "d", assigneeId: emp.id, status: "DONE", result: "42" }).returning();
    const [waiting] = await db.insert(tasks).values({ workspaceId: ws.id, title: "w", assigneeId: emp.id, status: "AWAITING_APPROVAL" }).returning();
    const [running] = await db.insert(tasks).values({ workspaceId: ws.id, title: "r", assigneeId: emp.id, status: "RUNNING" }).returning();
    expect((await callTool(a.token, "wait_for_task", { taskId: done!.id })).data).toMatchObject({ status: "done", result: "42" });
    expect((await callTool(a.token, "wait_for_task", { taskId: waiting!.id })).data).toMatchObject({ status: "needs_approval" });
    expect((await callTool(a.token, "wait_for_task", { taskId: running!.id, timeoutSec: 0 })).data).toMatchObject({ status: "running" });
    const started = Date.now();
    expect((await callTool(a.token, "wait_for_task", { taskId: running!.id, timeoutSec: 1 })).data).toMatchObject({ status: "timeout", taskStatus: "RUNNING" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect((await callTool(a.token, "wait_for_task", { taskId: running!.id, timeoutSec: 61 })).isError).toBe(true);
  });

  it("list_approvals hides the payload from members and shows it to admins", async () => {
    const { ws, emp } = await workspace();
    const [t] = await db.insert(tasks).values({ workspaceId: ws.id, title: "Invoice", assigneeId: emp.id, status: "AWAITING_APPROVAL" }).returning();
    await db.insert(approvals).values({ workspaceId: ws.id, taskId: t!.id, employeeId: emp.id, toolName: "send_email", title: "Send invoice", payload: { to: "client@example.com", body: "secret terms" } });
    await db.insert(approvals).values({ workspaceId: ws.id, taskId: t!.id, employeeId: emp.id, toolName: "send_email", title: "Old", payload: {}, status: "REJECTED" });
    const m = await withToken(ws.id, "MEMBER");
    const r = await callTool(m.token, "list_approvals");
    const list = r.data.approvals as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Send invoice", tool: "send_email", status: "PENDING", employee: { id: emp.id, name: "Sari" } });
    expect(list[0]).not.toHaveProperty("payload");
    expect(r.text).not.toContain("secret terms");
    expect((await callTool(m.token, "get_task", { taskId: t!.id })).data.pendingApprovals).toBe(1);

    const adm = await withToken(ws.id, "ADMIN");
    const ra = await callTool(adm.token, "list_approvals");
    expect((ra.data.approvals as Record<string, unknown>[])[0]).toMatchObject({ payload: { to: "client@example.com", body: "secret terms" } });
  });
});
