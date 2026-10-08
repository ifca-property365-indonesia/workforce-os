import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCredentialStatus, removeClaudeCredential, resolveClaudeCredential, setClaudeCredential } from "@wfos/db";
import { getSql } from "@wfos/db";
import { runAgent, MissingCredentialError } from "../src/runner/executor";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { makeEmployee, makeWorkspace, runContext } from "./fixtures";

const PLATFORM_SECRETS = ["DATABASE_URL", "ENCRYPTION_KEY", "AUTH_SECRET", "REDIS_URL", "TEST_DATABASE_ADMIN_URL", "GOOGLE_CLIENT_SECRET", "SMTP_PASSWORD"];
const saved = { ...process.env };

beforeEach(() => {
  process.env.CLAUDE_AUTH_MODE = "oauth";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "instance-token-xyz9";
  process.env.CLAUDE_INSTANCE_FALLBACK = "true";
});
afterEach(() => {
  setQueryImpl(null);
  for (const k of ["CLAUDE_AUTH_MODE", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_INSTANCE_FALLBACK", "ANTHROPIC_API_KEY"]) process.env[k] = saved[k];
});

async function runEnv(ws: { id: string }) {
  const emp = await makeEmployee(ws.id);
  const mock = mockRunner([{ result: "ok" }]);
  setQueryImpl(mock.query);
  await runAgent({ ctx: runContext(ws, emp, null), model: "claude-sonnet-5-5", systemPrompt: "", prompt: "x", creditBudget: 10 });
  return mock.lastOptions!.env as Record<string, string | undefined>;
}

describe("Claude credentials per workspace", () => {
  it("a run receives only its own workspace's credential", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await setClaudeCredential(a.id, "oauth", "sk-ant-oat01-workspace-A-aaaa");
    await setClaudeCredential(b.id, "api_key", "sk-ant-api03-workspace-B-bbbb");
    const envA = await runEnv(a);
    expect(envA.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-workspace-A-aaaa");
    expect(envA.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(envA)).not.toContain("workspace-B");
    expect(JSON.stringify(envA)).not.toContain("instance-token");
    const envB = await runEnv(b);
    expect(envB.ANTHROPIC_API_KEY).toBe("sk-ant-api03-workspace-B-bbbb");
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("the agent env never contains platform secrets", async () => {
    process.env.SMTP_PASSWORD = "smtp-secret";
    process.env.AUTH_SECRET = "auth-secret-value-1234567890123456";
    const ws = await makeWorkspace();
    await setClaudeCredential(ws.id, "oauth", "sk-ant-oat01-own-cccc");
    const env = await runEnv(ws);
    for (const k of PLATFORM_SECRETS) expect(env[k], k).toBeUndefined();
    const dump = JSON.stringify(env);
    for (const k of ["DATABASE_URL", "ENCRYPTION_KEY", "AUTH_SECRET", "SMTP_PASSWORD"]) {
      if (process.env[k]) expect(dump).not.toContain(process.env[k]!);
    }
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "DISABLE_AUTOUPDATER", "HOME", "LANG", "PATH"]);
  });

  it("each workspace gets its own agent HOME", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    expect((await runEnv(a)).HOME).not.toBe((await runEnv(b)).HOME);
    expect((await runEnv(a)).HOME).toContain(a.id);
  });

  it("falls back to the instance credential only while the fallback is enabled", async () => {
    const ws = await makeWorkspace();
    expect((await runEnv(ws)).CLAUDE_CODE_OAUTH_TOKEN).toBe("instance-token-xyz9");
    process.env.CLAUDE_INSTANCE_FALLBACK = "false";
    expect(await resolveClaudeCredential(ws.id)).toBeNull();
    const emp = await makeEmployee(ws.id);
    const mock = mockRunner([{ result: "never" }]);
    setQueryImpl(mock.query);
    await expect(runAgent({ ctx: runContext(ws, emp, null), model: "m", systemPrompt: "", prompt: "x", creditBudget: 10 })).rejects.toBeInstanceOf(MissingCredentialError);
    expect(mock.started).toBe(0);
  });

  it("is stored encrypted and its status exposes only type and last 4 characters", async () => {
    const ws = await makeWorkspace();
    const secret = "sk-ant-oat01-very-secret-token-9z8y";
    await setClaudeCredential(ws.id, "oauth", secret);
    const rows = await getSql()`select config, secret_enc from credentials where workspace_id = ${ws.id} and kind = 'claude'`;
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain("very-secret");
    const status = await claudeCredentialStatus(ws.id);
    expect(status.workspace).toMatchObject({ type: "oauth", last4: "9z8y" });
    expect(JSON.stringify(status)).not.toContain("very-secret");
    expect(status.effective).toEqual({ source: "workspace", type: "oauth" });
    await removeClaudeCredential(ws.id);
    expect((await claudeCredentialStatus(ws.id)).effective).toEqual({ source: "instance", type: "oauth" });
  });
});
