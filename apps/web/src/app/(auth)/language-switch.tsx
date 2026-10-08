"use client";

import { useLocale, useTranslations } from "next-intl";
import { LOCALES, LOCALE_NAMES } from "@wfos/shared";
import { api } from "@/lib/api";

/** Language choice for signed-out pages; stored in a cookie until the user picks one in their account. */
export function LanguageSwitch() {
  const t = useTranslations("common");
  const locale = useLocale();
  return (
    <select
      aria-label={t("language")}
      className="h-8 rounded-md border bg-background px-2 text-xs"
      value={locale}
      onChange={async (e) => {
        await api.post("/api/locale", { locale: e.target.value });
        window.location.reload();
      }}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
