import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { serverEnv } from "@/lib/server/env";

export async function GET() {
  if (!serverEnv.googleClientId) return NextResponse.redirect(`${serverEnv.appUrl}/login?error=google_not_configured`);
  const state = randomBytes(16).toString("hex");
  (await cookies()).set("wfos_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: serverEnv.appUrl.startsWith("https"), path: "/", maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", serverEnv.googleClientId);
  url.searchParams.set("redirect_uri", `${serverEnv.appUrl}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return NextResponse.redirect(url.toString());
}
