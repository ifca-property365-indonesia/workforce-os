import "server-only";
import { cookies } from "next/headers";
import { serverEnv } from "./env";

/**
 * Names and options of the sign-in cookies. Over https they carry the `__Host-` prefix: the browser then only
 * accepts them from this exact host (Secure, Path=/, no Domain), so a page on a sibling subdomain, such as an app
 * preview at <app>.preview.<this domain>, cannot plant or overwrite a session (login fixation, forced sign-out).
 */
export function authCookieName(base: string): string {
  return isSecure() ? `__Host-${base}` : base;
}

function isSecure(): boolean {
  return serverEnv.appUrl.startsWith("https://");
}

export function authCookieOptions(maxAge: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: isSecure(), path: "/", maxAge };
}

/** Expire a sign-in cookie with the same attributes it was set with (a plain delete would not match `__Host-`). */
export async function clearAuthCookie(base: string): Promise<void> {
  (await cookies()).set(authCookieName(base), "", authCookieOptions(0));
}
