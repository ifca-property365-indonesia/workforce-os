import "server-only";
import { cookies } from "next/headers";
import type { Locale } from "@wfos/shared";
import { LOCALE_COOKIE } from "@/i18n/locale";
import { serverEnv } from "./env";

/** Remembers the language for signed-out pages on this browser; null clears it. */
export async function setLocaleCookie(locale: Locale | null): Promise<void> {
  const jar = await cookies();
  if (!locale) jar.delete(LOCALE_COOKIE);
  else jar.set(LOCALE_COOKIE, locale, { httpOnly: false, sameSite: "lax", secure: serverEnv.appUrl.startsWith("https://"), path: "/", maxAge: 365 * 86400 });
}
