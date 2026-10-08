import { getRequestConfig } from "next-intl/server";
import { APP_TIME_ZONE, currentLocale } from "./locale";
import { loadMessages } from "./messages";

export default getRequestConfig(async () => {
  const locale = await currentLocale();
  return { locale, messages: await loadMessages(locale), timeZone: APP_TIME_ZONE };
});
