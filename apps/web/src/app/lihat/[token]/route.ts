import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { db, shareLinks } from "@wfos/db";
import { authCookieName, authCookieOptions } from "@/lib/server/auth-cookies";
import { serverEnv } from "@/lib/server/env";
import { hashShareToken, VIEW_COOKIE } from "@/lib/server/share";

export const dynamic = "force-dynamic";

/**
 * Open a view-only link: a valid one sets the view cookie (until the link expires) and goes to the dashboard; an
 * expired or revoked one goes to the sign-in page. A person who is signed in keeps their own session (it wins).
 */
export async function GET(_req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const base = serverEnv.appUrl.replace(/\/+$/, "");
  const [row] =
    token.length >= 20 && token.length <= 100
      ? await db
          .update(shareLinks)
          .set({ opens: sql`${shareLinks.opens} + 1`, lastUsedAt: new Date() })
          .where(and(eq(shareLinks.tokenHash, hashShareToken(token)), isNull(shareLinks.revokedAt), gt(shareLinks.expiresAt, new Date())))
          .returning({ expiresAt: shareLinks.expiresAt })
      : [];
  if (!row) return NextResponse.redirect(`${base}/login?view=expired`, 303);
  const seconds = Math.max(60, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
  (await cookies()).set(authCookieName(VIEW_COOKIE), token, authCookieOptions(seconds));
  return NextResponse.redirect(`${base}/dashboard`, 303);
}
