import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  transpilePackages: ["@wfos/db", "@wfos/shared", "@wfos/templates"],
  serverExternalPackages: ["bullmq", "ioredis", "postgres", "nodemailer", "bcryptjs"],
  poweredByHeader: false,
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
};
export default withNextIntl(config);
