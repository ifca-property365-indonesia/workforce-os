"use client";

import { useMemo } from "react";
import { useLocale, useTimeZone } from "next-intl";
import { createFormatter, type Formatter } from "./format";

/** Formatter bound to the current UI locale and time zone. */
export function useFormat(): Formatter {
  const locale = useLocale();
  const timeZone = useTimeZone() ?? "Asia/Jakarta";
  return useMemo(() => createFormatter(locale, timeZone), [locale, timeZone]);
}
