import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { eq, or } from "drizzle-orm";
import { decodeJwt } from "jose";
import { audit, db, members, seedPrices, users, workspaces } from "@wfos/db";
import { withRetry } from "@wfos/shared/server";
import { setSession } from "@/lib/server/auth";
import { serverEnv } from "@/lib/server/env";
import { logger } from "@/lib/server/logger";
import { signupAllowed } from "@/lib/server/signup";
import { setTwoFactorChallenge } from "@/lib/server/twofactor";

export async function GET(req: NextRequest) {
  const fail = (reason: string) => NextResponse.redirect(`${serverEnv.appUrl}/login?error=${encodeURIComponent(reason)}`);
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const jar = await cookies();
  if (!code || !state || state !== jar.get("wfos_oauth_state")?.value) return fail("invalid_state");
  jar.delete("wfos_oauth_state");
  try {
    const tokens = await withRetry(
      async (signal) => {
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: serverEnv.googleClientId,
            client_secret: serverEnv.googleClientSecret,
            redirect_uri: `${serverEnv.appUrl}/api/auth/google/callback`,
            grant_type: "authorization_code",
          }),
          signal,
        });
        if (!r.ok) throw Object.assign(new Error(`token exchange ${r.status}`), { noRetry: r.status < 500 });
        return (await r.json()) as { id_token: string };
      },
      { retries: 2, timeoutMs: 10000, label: "google-token" },
    );
    // id_token comes straight from Google's token endpoint over TLS (no third party), so decoding is sufficient here.
    const claims = decodeJwt(tokens.id_token) as { sub: string; email?: string; email_verified?: boolean; name?: string; aud?: string };
    if (claims.aud !== serverEnv.googleClientId || !claims.email || !claims.email_verified) return fail("unverified_email");
    const email = claims.email.toLowerCase();
    let [user] = await db.select().from(users).where(or(eq(users.googleSub, claims.sub), eq(users.email, email)));
    if (!user) {
      if (!(await signupAllowed())) return fail("signup_disabled");
      [user] = await db.insert(users).values({ email, name: claims.name ?? email, googleSub: claims.sub }).returning();
      const [ws] = await db
        .insert(workspaces)
        .values({ name: `${(claims.name ?? email).split(" ")[0]}'s workspace`, slug: `ws-${Math.random().toString(36).slice(2, 9)}`, notifyEmail: email })
        .returning();
      await db.insert(members).values({ workspaceId: ws!.id, userId: user!.id, role: "OWNER" });
      await seedPrices(db);
      await audit({ workspaceId: ws!.id, actorUserId: user!.id, actorLabel: email, action: "workspace.created", targetType: "workspace", targetId: ws!.id, details: { via: "google" } });
    } else if (!user.googleSub) {
      await db.update(users).set({ googleSub: claims.sub }).where(eq(users.id, user.id));
    }
    // Google proves the password factor only: lockout and 2FA apply exactly as for password sign-in
    if (user!.lockedUntil && user!.lockedUntil.getTime() > Date.now()) return fail("account_locked");
    if (user!.totpSecretEnc) {
      await setTwoFactorChallenge(user!.id);
      return NextResponse.redirect(`${serverEnv.appUrl}/login?step=2fa`);
    }
    await setSession(user!.id);
    return NextResponse.redirect(`${serverEnv.appUrl}/dashboard`);
  } catch (e) {
    logger.error({ err: (e as Error).message }, "google sign-in failed");
    return fail("google_failed");
  }
}
