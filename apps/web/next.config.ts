import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@wfos/db", "@wfos/shared", "@wfos/templates"],
  serverExternalPackages: ["bullmq", "ioredis", "postgres", "nodemailer", "bcryptjs"],
  poweredByHeader: false,
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
};
export default config;
