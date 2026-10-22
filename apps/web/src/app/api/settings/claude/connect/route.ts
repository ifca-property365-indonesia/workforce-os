import { randomUUID } from "node:crypto";
import { CLAUDE_LOGIN_MINUTES, type ClaudeLoginState } from "@wfos/shared";
import { claudeLoginRedisKey, readClaudeLogin } from "@/lib/server/claude-login";
import { control, redis } from "@/lib/server/queue";
import { route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

/** The sign-in in progress (link, then the result); the page polls it. */
export const GET = route("OWNER", async ({ session }) => ({ login: await readClaudeLogin(session.workspaceId) }));

/** Start (or restart) a sign-in: a fresh step-up, since the result replaces the credential every run uses. */
export const POST = route("OWNER", async ({ session }) => {
  await requireStepUp(session);
  const now = Date.now();
  const login: ClaudeLoginState = {
    id: randomUUID(),
    status: "starting",
    url: null,
    error: null,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CLAUDE_LOGIN_MINUTES * 60_000).toISOString(),
    last4: null,
  };
  await redis().set(claudeLoginRedisKey(session.workspaceId), JSON.stringify(login), "EX", CLAUDE_LOGIN_MINUTES * 60 + 60);
  await control({ type: "claude_login_start", workspaceId: session.workspaceId, sessionId: login.id, userId: session.userId, email: session.email });
  return { login };
});

export const DELETE = route("OWNER", async ({ session }) => {
  const login = await readClaudeLogin(session.workspaceId);
  if (login) {
    await redis().del(claudeLoginRedisKey(session.workspaceId));
    await control({ type: "claude_login_cancel", workspaceId: session.workspaceId, sessionId: login.id });
  }
  return { login: null };
});
