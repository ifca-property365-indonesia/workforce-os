import { randomBytes } from "node:crypto";

export interface SeedOwnerPlan {
  email: string;
  password: string;
  /** a generated password must be replaced at first login */
  mustChangePassword: boolean;
  generated: boolean;
}

/**
 * The demo owner and sample data are created only when asked for (SEED_DEMO=true or an explicit
 * SEED_OWNER_PASSWORD): a public instance must never start with an account whose password is known.
 * The first real user signs up instead (always allowed for the first account).
 */
export function seedOwnerPlan(env: NodeJS.ProcessEnv = process.env): SeedOwnerPlan | null {
  const explicit = env.SEED_OWNER_PASSWORD?.trim();
  if (env.SEED_DEMO !== "true" && !explicit) return null;
  if (explicit && explicit.length < 10) throw new Error("SEED_OWNER_PASSWORD must be at least 10 characters");
  const password = explicit || randomBytes(12).toString("base64url");
  return { email: (env.SEED_OWNER_EMAIL?.trim() || "owner@workforce.local").toLowerCase(), password, mustChangePassword: !explicit, generated: !explicit };
}
