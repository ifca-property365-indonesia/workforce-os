import pino from "pino";
import { env } from "./env";

export const log = pino({
  level: env.logLevel,
  base: { svc: "worker" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ["*.password", "*.secret", "*.token", "*.apiKey"], censor: "[redacted]" },
});
