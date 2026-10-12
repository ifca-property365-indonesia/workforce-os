import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Figtree } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import "./globals.css";
import { Providers } from "./providers";
import { RegisterServiceWorker } from "@/components/pwa/register";
import { VIEW_SCRIPT } from "@/lib/view-mode";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" });
// sign-painter capitals for titles and the employee signs (see globals.css font-display)
const shoulders = Big_Shoulders({ subsets: ["latin"], variable: "--font-shoulders", axes: ["opsz"] });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    title: "Workforce OS",
    description: t("appDescription"),
    applicationName: "Workforce OS",
    appleWebApp: { capable: true, title: "Workforce OS", statusBarStyle: "default" },
    icons: { icon: "/icons/icon.svg", apple: "/icons/apple-touch-icon.png" },
  };
}

export const viewport: Viewport = { themeColor: "#110e15" };

// night (dark) is the default; only an explicit choice of the day theme turns it off
const themeScript = `try{if(localStorage.getItem('wfos-theme')==='light')document.documentElement.classList.remove('dark')}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning className={`${figtree.variable} ${shoulders.variable} dark`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript + VIEW_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
          <RegisterServiceWorker />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
