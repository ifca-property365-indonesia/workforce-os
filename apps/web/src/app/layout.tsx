import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import "./globals.css";
import { Providers } from "./providers";
import { RegisterServiceWorker } from "@/components/pwa/register";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

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

export const viewport: Viewport = { themeColor: "#3a4bc4" };

const themeScript = `try{var t=localStorage.getItem('wfos-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning className={inter.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
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
