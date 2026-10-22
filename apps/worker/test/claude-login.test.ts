import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, resolveClaudeCredential } from "@wfos/db";
import { claudeLoginKey, type ClaudeLoginState } from "@wfos/shared";
import { env } from "../src/lib/env";
import { redis } from "../src/lib/redis";
import {
  activeClaudeLogins,
  cancelClaudeLogin,
  loginUrlOf,
  recoverClaudeLogins,
  startClaudeLogin,
  stopClaudeLogins,
  submitClaudeLoginCode,
  tokenOf,
} from "../src/claude-login";
import { makeWorkspace } from "./fixtures";

const TOKEN = "sk-ant-oat01-FAKEtokenFAKEtokenFAKEtoken_ab12";
const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=s1";

// Stands in for `claude setup-token`: prints the link as an OSC 8 hyperlink, reads the code from the terminal, then
// prints the token (right code) or an OAuth error (any other). Records its environment next to itself.
const FAKE_CLI = `#!/bin/bash
env > "$(dirname "$0")/env.txt"
printf 'Welcome to Claude Code\\r\\n\\033]8;id=x;%s\\007%s\\033]8;;\\007\\r\\n' '${LINK}' '${LINK.slice(0, 40)}'
printf 'Paste code here if prompted > '
read -r code
if [ "$code" = "good-code-1234#s1" ]; then
  printf '\\r\\n\\033[32mLong-lived authentication token created successfully!\\033[0m\\r\\n\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n${TOKEN}\\r\\n'
  exit 0
fi
printf '\\r\\nOAuth error: Invalid code\\r\\n'
sleep 30
`;

let fakeDir = "";
beforeAll(async () => {
  fakeDir = await mkdtemp(path.join(os.tmpdir(), "wfos-fake-claude-"));
  await writeFile(path.join(fakeDir, "claude"), FAKE_CLI);
  await chmod(path.join(fakeDir, "claude"), 0o755);
  process.env.WFOS_CLAUDE_LOGIN_BIN = path.join(fakeDir, "claude");
});
afterEach(() => stopClaudeLogins());

async function state(ws: string): Promise<ClaudeLoginState | null> {
  const raw = await redis.get(claudeLoginKey(ws, env.namespace));
  return raw ? (JSON.parse(raw) as ClaudeLoginState) : null;
}

async function until(ws: string, status: ClaudeLoginState["status"], ms = 10_000): Promise<ClaudeLoginState> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state(ws);
    if (s?.status === status) return s;
    if (Date.now() > end) throw new Error(`still ${s?.status ?? "no state"} (${s?.error ?? ""}), wanted ${status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const start = (ws: string, sessionId = randomUUID()) => startClaudeLogin({ workspaceId: ws, sessionId, userId: randomUUID(), email: "owner@test.local" }).then(() => sessionId);

describe("Connect Claude: parsing the CLI's terminal output", () => {
  it("takes the sign-in link from the hyperlink, only on a Claude host", () => {
    expect(loginUrlOf(`x\x1b]8;id=1;${LINK}\x07${LINK.slice(0, 30)}\x1b]8;;\x07`)).toBe(LINK);
    expect(loginUrlOf(`Use the url below\r\n${LINK}\r\n`)).toBe(LINK);
    expect(loginUrlOf("\x1b]8;id=1;https://evil.example/cai/oauth/authorize?state=s\x07")).toBeNull();
    expect(loginUrlOf("https://claude.com/somewhere-else?x=1")).toBeNull();
  });

  it("finds the token between colour codes", () => {
    expect(tokenOf(`token:\r\n\x1b[1m${TOKEN}\x1b[0m\r\n`)).toBe(TOKEN);
    expect(tokenOf("sk-ant-api03-not-a-subscription-token-at-all")).toBeNull();
  });
});

describe("Connect Claude: sign-in through the worker", () => {
  it("shows the link, forwards the code, stores the token for that workspace only", async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    const id = await start(ws.id);
    const waiting = await until(ws.id, "awaiting_code");
    expect(waiting.url).toBe(LINK);

    await submitClaudeLoginCode({ workspaceId: ws.id, sessionId: id, code: "good-code-1234#s1" });
    const done = await until(ws.id, "connected");
    expect(done.last4).toBe("ab12");
    expect(JSON.stringify(done)).not.toContain("FAKEtoken");

    expect(await resolveClaudeCredential(ws.id)).toMatchObject({ type: "oauth", secret: TOKEN, source: "workspace" });
    expect((await resolveClaudeCredential(other.id))?.secret).not.toBe(TOKEN);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "credential.claude_set")));
    expect(rows[0]?.details).toMatchObject({ via: "connect", last4: "ab12" });
    expect(activeClaudeLogins()).toBe(0);
  });

  it("runs the CLI with a throw-away HOME and none of the platform's secrets, and removes the HOME afterwards", async () => {
    const ws = await makeWorkspace();
    const id = await start(ws.id);
    await until(ws.id, "awaiting_code");
    const cliEnv = await readFile(path.join(fakeDir, "env.txt"), "utf8");
    const home = cliEnv.match(/^HOME=(.*)$/m)?.[1] ?? "";
    expect(path.basename(home)).toMatch(/^wfos-claude-login-/);
    for (const secret of ["ENCRYPTION_KEY", "DATABASE_URL", "REDIS_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(cliEnv).not.toContain(`${secret}=`);
    await submitClaudeLoginCode({ workspaceId: ws.id, sessionId: id, code: "good-code-1234#s1" });
    await until(ws.id, "connected");
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(home)).toBe(false);
  });

  it("a rejected code fails the sign-in and stores nothing", async () => {
    const ws = await makeWorkspace();
    const id = await start(ws.id);
    await until(ws.id, "awaiting_code");
    await submitClaudeLoginCode({ workspaceId: ws.id, sessionId: id, code: "wrong-code-0000#s1" });
    expect((await until(ws.id, "failed")).error).toBe("invalid_code");
    expect((await resolveClaudeCredential(ws.id))?.source).not.toBe("workspace");
  });

  it("ignores a code for an older sign-in, and cancel removes the state", async () => {
    const ws = await makeWorkspace();
    const first = await start(ws.id);
    await until(ws.id, "awaiting_code");
    const second = await start(ws.id);
    await until(ws.id, "awaiting_code");
    await submitClaudeLoginCode({ workspaceId: ws.id, sessionId: first, code: "good-code-1234#s1" });
    expect((await state(ws.id))?.status).toBe("awaiting_code");
    expect((await state(ws.id))?.id).toBe(second);
    await cancelClaudeLogin({ workspaceId: ws.id, sessionId: second });
    expect(await state(ws.id)).toBeNull();
    expect(activeClaudeLogins()).toBe(0);
  });

  it("a sign-in of a previous worker process is marked failed on start", async () => {
    const ws = await makeWorkspace();
    const st: ClaudeLoginState = { id: randomUUID(), status: "awaiting_code", url: LINK, error: null, startedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), last4: null };
    await redis.set(claudeLoginKey(ws.id, env.namespace), JSON.stringify(st), "EX", 600);
    await recoverClaudeLogins([ws.id]);
    expect(await state(ws.id)).toMatchObject({ status: "failed", error: "worker_restarted" });
  });
});
