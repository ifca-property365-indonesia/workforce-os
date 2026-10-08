import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  transpilePackages: ["@wfos/db", "@wfos/shared", "@wfos/templates"],
  serverExternalPackages: ["bullmq", "ioredis", "postgres", "nodemailer", "bcryptjs"],
  poweredByHeader: false,
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
  // the service worker must always be revalidated, or clients keep an old one for up to a day
  headers: async () => [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Content-Type", value: "application/javascript; charset=utf-8" }] }],
};
export default withNextIntl(config);
