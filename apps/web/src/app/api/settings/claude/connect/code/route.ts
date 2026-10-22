import { z } from "zod";
import { CLAUDE_LOGIN_CODE_RE } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { readClaudeLogin } from "@/lib/server/claude-login";
import { control } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

const schema = z.object({
  sessionId: z.string().uuid(),
  code: z.string().trim().regex(CLAUDE_LOGIN_CODE_RE, "Copy the whole code from the Claude page"),
});

/** The code claude.com showed after sign-in, forwarded to the waiting CLI; the page keeps polling for the result. */
export const POST = route("OWNER", async ({ session, req }) => {
  await requireStepUp(session);
  const { sessionId, code } = await body(req, schema);
  const login = await readClaudeLogin(session.workspaceId);
  if (!login || login.id !== sessionId || login.status !== "awaiting_code") {
    throw new HttpError(409, "This sign-in is no longer waiting for a code; start again", { code: "claude_login_not_waiting" });
  }
  await control({ type: "claude_login_code", workspaceId: session.workspaceId, sessionId, code });
  return { login: { ...login, status: "verifying" } };
});
