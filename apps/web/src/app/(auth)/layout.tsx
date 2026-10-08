import { Bot } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { LanguageSwitch } from "./language-switch";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("auth");
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Bot className="size-6" /> Workforce OS
        </div>
        <div className="space-y-4">
          <h1 className="text-4xl font-semibold leading-tight">
            {t.rich("hero.title", { br: () => <br /> })}
          </h1>
          <p className="max-w-md text-indigo-200">{t("hero.subtitle")}</p>
          <ul className="space-y-1 text-sm text-indigo-200">
            <li>• {t("hero.point1")}</li>
            <li>• {t("hero.point2")}</li>
            <li>• {t("hero.point3")}</li>
          </ul>
        </div>
        <p className="text-xs text-indigo-300">{t("hero.footer")}</p>
      </div>
      <div className="relative flex items-center justify-center p-6">
        <div className="absolute right-4 top-4">
          <LanguageSwitch />
        </div>
        {children}
      </div>
    </div>
  );
}
