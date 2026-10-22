import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, members, users, workspaces } from "@wfos/db";
import { claudeLoginKey, type ClaudeLoginState } from "@wfos/shared";
import { totp } from "@wfos/shared/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as login2fa } from "@/app/api/auth/login/2fa/route";
import { POST as setup2fa } from "@/app/api/me/2fa/setup/route";
import { POST as enable2fa } from "@/app/api/me/2fa/enable/route";
import { POST as reauth } from "@/app/api/me/reauth/route";
import { DELETE as cancel, GET as status, POST as start } from "@/app/api/settings/claude/connect/route";
import { POST as sendCode } from "@/app/api/settings/claude/connect/code/route";
import { serverEnv } from "@/lib/server/env";
import { control, redis } from "@/lib/server/queue";
import { call, jar, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());
const PASSWORD = "pw-123456-claude";

async function member(role: "OWNER" | "ADMIN") {
  const [ws] = await db.insert(workspaces).values({ name: "Kantor", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `o-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "O", passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  const secret = String((await call(setup2fa, "POST", "/api/me/2fa/setup")).json.secret);
  expect((await call(enable2fa, "POST", "/api/me/2fa/enable", { code: totp(secret, Date.now() - 30_000) })).status).toBe(200);
  jar.clear();
  await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
  await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
  const stepUp = async () => expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
  return { ws: ws!, stepUp };
}

/** what the web asked the worker to do (the control channel is recorded by the test queue module) */
async function controlMessages(fn: () => Promise<unknown>): Promise<unknown[]> {
  vi.mocked(control).mockClear();
  await fn();
  return vi.mocked(control).mock.calls.map((c) => c[0]);
}

describe("Connect Claude API", () => {
  it("only an Owner, with a fresh step-up, starts a sign-in; the worker is asked to run it", async () => {
    const o = await member("OWNER");
    expect((await call(start, "POST", "/api/settings/claude/connect")).json.code).toBe("step_up_required");
    await o.stepUp();
    let login: ClaudeLoginState | undefined;
    const sent = await controlMessages(async () => {
      const r = await call(start, "POST", "/api/settings/claude/connect");
      expect(r.status).toBe(200);
      login = r.json.login as ClaudeLoginState;
    });
    expect(login).toMatchObject({ status: "starting", url: null });
    expect(sent).toEqual([expect.objectContaining({ type: "claude_login_start", workspaceId: o.ws.id, sessionId: login!.id })]);
    expect((await call(status, "GET", "/api/settings/claude/connect")).json.login).toMatchObject({ id: login!.id });
  });

  it("an Admin cannot start one", async () => {
    await member("ADMIN");
    expect((await call(start, "POST", "/api/settings/claude/connect")).status).toBe(403);
    expect((await call(status, "GET", "/api/settings/claude/connect")).status).toBe(403);
  });

  it("forwards a code only while the sign-in waits for it, and only a well-formed one", async () => {
    const o = await member("OWNER");
    await o.stepUp();
    const id = randomUUID();
    const waiting: ClaudeLoginState = { id, status: "awaiting_code", url: "https://claude.com/cai/oauth/authorize?x=1", error: null, startedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), last4: null };
    await redis().set(claudeLoginKey(o.ws.id, serverEnv.namespace), JSON.stringify(waiting), "EX", 600);

    expect((await call(sendCode, "POST", "/api/settings/claude/connect/code", { sessionId: id, code: "abc def; rm -rf /" })).status).toBe(400);
    expect((await call(sendCode, "POST", "/api/settings/claude/connect/code", { sessionId: randomUUID(), code: "good-code-1234#s1" })).json.code).toBe("claude_login_not_waiting");
    const sent = await controlMessages(async () => {
      const r = await call(sendCode, "POST", "/api/settings/claude/connect/code", { sessionId: id, code: "good-code-1234#s1" });
      expect((r.json.login as ClaudeLoginState).status).toBe("verifying");
    });
    expect(sent).toEqual([expect.objectContaining({ type: "claude_login_code", sessionId: id, code: "good-code-1234#s1" })]);
  });

  it("cancel removes the sign-in and tells the worker", async () => {
    const o = await member("OWNER");
    await o.stepUp();
    const id = ((await call(start, "POST", "/api/settings/claude/connect")).json.login as ClaudeLoginState).id;
    const sent = await controlMessages(() => call(cancel, "DELETE", "/api/settings/claude/connect"));
    expect(sent).toEqual([expect.objectContaining({ type: "claude_login_cancel", sessionId: id })]);
    expect((await call(status, "GET", "/api/settings/claude/connect")).json.login).toBeNull();
  });
});
