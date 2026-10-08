import "server-only";
import { cookies, headers } from "next/headers";
import { jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { db, members, users, workspaces } from "@wfos/db";
import { isLocale, resolveLocale, type Locale } from "@wfos/shared";
import { serverEnv } from "@/lib/server/env";

export const LOCALE_COOKIE = "wfos_locale";

/** IANA time zone for formatting dates on server and client (one per instance for now). */
export const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Jakarta";

async function signedInUserId(): Promise<string | null> {
  const token = (await cookies()).get("wfos_session")?.value;
  if (!token || serverEnv.authSecret.length < 32) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(serverEnv.authSecret));
    return payload.sub ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

/** User preference → workspace default → locale cookie (signed-out pages) → Accept-Language → English. */
export async function currentLocale(): Promise<Locale> {
  const jar = await cookies();
  const accept = (await headers()).get("accept-language");
  const cookieLocale = jar.get(LOCALE_COOKIE)?.value;
  const userId = await signedInUserId();
  if (userId) {
    const preferredWs = jar.get("wfos_ws")?.value;
    const rows = await db
      .select({ userLocale: users.locale, wsLocale: workspaces.defaultLocale, wsId: members.workspaceId })
      .from(users)
      .leftJoin(members, eq(members.userId, users.id))
      .leftJoin(workspaces, and(eq(workspaces.id, members.workspaceId)))
      .where(eq(users.id, userId));
    const row = rows.find((r) => r.wsId === preferredWs) ?? rows[0];
    if (row) return resolveLocale(row.userLocale, row.wsLocale, isLocale(cookieLocale) ? cookieLocale : accept);
  }
  return resolveLocale(null, null, isLocale(cookieLocale) ? cookieLocale : accept);
}
