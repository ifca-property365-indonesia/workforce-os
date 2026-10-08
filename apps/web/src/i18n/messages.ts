import type { Locale } from "@wfos/shared";
import { NAMESPACES } from "./namespaces";

export type Messages = Record<string, Record<string, unknown>>;

const cache = new Map<Locale, Messages>();

/** All namespaces of one locale, merged into { namespace: {...} }. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  const hit = cache.get(locale);
  if (hit && process.env.NODE_ENV === "production") return hit;
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => [ns, (await import(`../../messages/${locale}/${ns}.json`)).default as Record<string, unknown>] as const),
  );
  const messages = Object.fromEntries(entries) as Messages;
  cache.set(locale, messages);
  return messages;
}
