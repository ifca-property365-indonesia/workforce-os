import "server-only";
import { createTranslator } from "next-intl";
import type { Locale } from "@wfos/shared";
import { currentLocale } from "@/i18n/locale";
import { loadMessages } from "@/i18n/messages";

/** Translator over full keys ("errors.invalid_code"); keys are checked by test/i18n.test.ts, not by the type system. */
export interface ServerTranslator {
  (key: string, values?: Record<string, string | number | Date>): string;
  has(key: string): boolean;
}

/** Translator for route handlers (errors, emails), bound to the requesting user's locale. */
export async function serverT(locale?: Locale): Promise<{ locale: Locale; t: ServerTranslator }> {
  const l = locale ?? (await currentLocale());
  const messages = await loadMessages(l);
  return { locale: l, t: createTranslator({ locale: l, messages: messages as never }) as unknown as ServerTranslator };
}
