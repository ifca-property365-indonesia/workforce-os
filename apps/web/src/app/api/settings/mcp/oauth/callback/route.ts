import { NextResponse, type NextRequest } from "next/server";
import { HttpError, requireSession, type Session } from "@/lib/server/auth";
import { serverEnv } from "@/lib/server/env";
import { logger } from "@/lib/server/logger";
import { finishMcpOAuth, oauthErrorTag, takeMcpOAuthState } from "@/lib/server/mcp-oauth";

/** Outcome shown on Settings → Integrations (`settings.integrations.oauthResult.<code>`). */
type Outcome = "connected" | "invalid_state" | "denied" | "failed" | "forbidden";

/**
 * Where the authorization server sends the browser back. Only the owner who started the sign-in, in the same
 * workspace, can finish it, and each state works once.
 */
export async function GET(req: NextRequest) {
  const back = (outcome: Outcome) => NextResponse.redirect(`${serverEnv.appUrl}/settings?tab=integrations&mcp=${outcome}`);
  let session: Session;
  try {
    session = await requireSession("OWNER");
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return NextResponse.redirect(`${serverEnv.appUrl}/login`);
    return back("forbidden");
  }
  if (session.mustChangePassword || session.mustEnroll2fa) return back("forbidden");

  const sp = req.nextUrl.searchParams;
  const state = sp.get("state");
  const pending = state ? await takeMcpOAuthState(state, session) : null;
  if (!pending) return back("invalid_state");
  const code = sp.get("code");
  if (sp.get("error") || !code) return back(sp.get("error") === "access_denied" ? "denied" : "failed");
  try {
    await finishMcpOAuth(pending, code, session);
    return back("connected");
  } catch (e) {
    // the upstream text stays in the server log
    logger.warn({ server: pending.name, ...oauthErrorTag(e) }, "mcp oauth code exchange failed");
    return back("failed");
  }
}
