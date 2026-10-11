import { Check } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { LanguageSwitch } from "./language-switch";

/** Sign-in and account setup: the office's own night street, with the brand sign lit. */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations("auth");
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="hidden flex-col justify-between border-r bg-card p-10 lg:flex xl:p-14">
        <div className="flex items-center gap-3">
          <span
            className="sign flex size-12 items-center justify-center rounded-xl"
            data-state="lit"
            aria-hidden
          >
            <span className="font-display text-[1.6rem]">
              {/* i18n-ignore: the brand mark, not a word */}W
            </span>
          </span>
          <span className="font-display text-[1.7rem]">Workforce OS</span>
        </div>
        <div className="space-y-6">
          <h1 className="font-display max-w-[14ch] text-[4.2rem] text-balance">
            {t.rich("hero.title", { br: () => <br /> })}
          </h1>
          <p className="max-w-md text-lg text-muted-foreground">
            {t("hero.subtitle")}
          </p>
          <ul className="space-y-2.5 text-sm">
            {(["point1", "point2", "point3"] as const).map((k) => (
              <li key={k} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-success/15 text-success">
                  <Check className="size-3.5" aria-hidden />
                </span>
                {t(`hero.${k}`)}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">{t("hero.footer")}</p>
      </div>
      <div className="relative flex flex-col items-center justify-center gap-8 px-4 py-16 sm:px-6">
        <div className="absolute right-4 top-4">
          <LanguageSwitch />
        </div>
        <div className="flex items-center gap-3 lg:hidden">
          <span
            className="sign flex size-11 items-center justify-center rounded-xl"
            data-state="lit"
            aria-hidden
          >
            <span className="font-display text-[1.45rem]">
              {/* i18n-ignore: the brand mark, not a word */}W
            </span>
          </span>
          <span className="font-display text-[1.6rem]">Workforce OS</span>
        </div>
        {children}
      </div>
    </div>
  );
}
